const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const crypto = require('../src/crypto');
const { decodeResponse } = require('../src/xeapi');
const root = path.resolve(__dirname, '..'),
	secret = 'SECRET_NEVER_LOG',
	size = 360;
const baselinePath = process.argv[2] && path.resolve(process.argv[2]);
if (!baselinePath || !fs.existsSync(baselinePath))
	throw Error(
		'Usage: node scripts/privilege-regression.cjs PATH_TO_PHASE6_APP'
	);
if (
	require('node:crypto')
		.createHash('sha256')
		.update(fs.readFileSync(baselinePath))
		.digest('hex') !==
	'edd97a2f22757255a65c6bc05ec711200c84fccd14a4d1f8935763aa924bce10'
)
	throw Error('Baseline SHA-256 must be the verified phase-six app.');
const directory = fs.mkdtempSync(
	path.join(require('node:os').tmpdir(), 'unm-batch-regression-')
);
const preload = path.join(directory, 'dns-preload.cjs');
const mockProvider = path.join(root, 'src/provider/match.js');
fs.writeFileSync(
	preload,
	"require('dns').lookup=(host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}callback(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);};" +
		`if(process.env.STAGE9_TEST_MATCHER){const p=${JSON.stringify(mockProvider)}; require.cache[require.resolve(p)]={id:p,filename:p,loaded:true,exports:async()=>{if(process.env.STAGE9_TEST_MATCHER==='throw')throw Error('SECRET');return {url:'https://replacement/audio',br:320000,md5:'hash',size:1234};}};}`
);
const listen = (s) =>
	new Promise((resolve) =>
		s.listen(0, '127.0.0.1', () => resolve(s.address().port))
	);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paths = [
	'/api/song/enhance/player/url/v1',
	'/api/album/privilege',
	'/api/v1/artist/top/song',
	'/api/search/complex/get',
	'/api/song/enhance/player/url',
];
const inputs = Array.from(
	{ length: size },
	(_, i) => 'B=' + secret + '&S=' + secret + '&R=' + i
);
const responses = inputs.map((_, i) => {
	const status = [200, 200, 403, 500, 200][i % 5];
	const gray = {
		id: secret,
		name: secret,
		st: -200,
		pl: 0,
		dl: 0,
		sp: 0,
		cp: 0,
		subp: 0,
		fee: 8,
		payed: 0,
		fl: 0,
		flLevel: 'none',
		plLevel: 'none',
		dlLevel: 'none',
		playMaxbr: 999000,
		downloadMaxbr: 999000,
	};
	const json = {
		code: status,
		...(i % paths.length === 1
			? { data: [gray] }
			: {
					data: [
						{
							id: 123,
							code: i % 2 === 0 ? 404 : 200,
							name: secret,
							url:
								i % 2 === 0
									? null
									: 'https://' +
										secret +
										'/secret?token=' +
										secret,
							br: i % 2 === 0 ? 0 : 320000,
							size: 999,
							type: 'mp3',
							level: 'exhigh',
							flag: 0,
							privilege: gray,
							freeTrialInfo: { message: secret, code: 123 },
							trialInfo: null,
							message: secret,
						},
					],
				}),
		user: { token: secret },
	};
	let raw = Buffer.from(JSON.stringify(json));
	if (i % 2 === 1) raw = zlib.gzipSync(raw);
	let body = crypto.eapi.encrypt(raw);
	if (i % 17 === 0) body = Buffer.from('invalid ciphertext');
	const encoding = [undefined, 'gzip', 'deflate', 'br'][
		Math.floor(i / 5) % 4
	];
	if (encoding === 'gzip') body = zlib.gzipSync(body);
	if (encoding === 'deflate') body = zlib.deflateSync(body);
	if (encoding === 'br') body = zlib.brotliCompressSync(body);
	return {
		status,
		body,
		encoding,
		json,
		inner: i % 2 === 1,
		corrupt: i % 17 === 0,
	};
});
async function run(name, app, enabled, failWrite = false, mode = '') {
	const forwarded = Array(size),
		results = Array(size),
		log = path.join(directory, name + '.log'),
		batch = path.join(directory, name + '.batch');
	fs.writeFileSync(log, '');
	if (fs.existsSync(batch)) fs.unlinkSync(batch);
	const upstream = http.createServer(async (req, res) => {
		const i = Number(req.headers['x-test-seq']),
			chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		forwarded[i] = {
			body: Buffer.concat(chunks),
			headers: req.rawHeaders,
			path: req.url,
			method: req.method,
		};
		const fixture = responses[i];
		res.writeHead(fixture.status, {
			date: 'Thu, 01 Oct 2026 00:00:00 GMT',
			'content-type': 'application/octet-stream',
			'content-length': String(fixture.body.length),
			'x-fixture': String(i),
			'x-encr-ssid': secret,
			...(fixture.encoding
				? { 'content-encoding': fixture.encoding }
				: {}),
		});
		res.end(fixture.body);
	});
	let child,
		stderr = '';
	const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
	try {
		const upstreamPort = await listen(upstream),
			reservation = net.createServer(),
			proxyPort = await listen(reservation);
		await new Promise((resolve) => reservation.close(resolve));
		const env = {
			...process.env,
			LOG_FILE: log,
			LOG_LEVEL: 'info',
			JSON_LOG: 'false',
			ENABLE_HTTPDNS: 'false',
			STAGE9_TEST_MATCHER: mode,
			UNM_BATCH_OBSERVER: 'false',
			UNM_PRIVILEGE_OBSERVER: 'false',
			UNM_PRIVILEGE_VALUE_OBSERVER: 'false',
			UNM_XEAPI_PRIVILEGE_PATCH: 'true',
			UNM_ALBUM_PLAY_OBSERVER: 'false',
			UNM_XEAPI_PLAYER_URL_PATCH: String(enabled),
			UNM_XEAPI_PLAYER_URL_PATCH_LOG_FILE: failWrite ? directory : batch,
			UNM_ALBUM_PLAY_LOG_FILE: failWrite ? directory : batch,
			SIGN_CERT: path.join(root, 'server.crt'),
			SIGN_KEY: path.join(root, 'server.key'),
		};
		delete env.NETEASE_COOKIE;
		child = spawn(
			process.execPath,
			[
				'--require',
				path.join(root, '.pnp.cjs'),
				'--require',
				preload,
				app,
				'-a',
				'127.0.0.1',
				'-p',
				String(proxyPort),
				'-f',
				'127.0.0.1',
			],
			{ env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		child.stderr.on('data', (data) => (stderr += data));
		let until = Date.now() + 8000;
		while (!fs.readFileSync(log, 'utf8').includes('HTTP Server running')) {
			if (Date.now() > until || child.exitCode !== null)
				throw Error('Startup failed: ' + stderr.slice(-800));
			await sleep(10);
		}
		const send = (i) =>
			new Promise((resolve, reject) => {
				const req = http.request(
					{
						hostname: '127.0.0.1',
						port: proxyPort,
						agent,
						method: 'POST',
						path: `http://interface3.music.163.com:${upstreamPort}${paths[i % paths.length].replace('/api/', '/xeapi/')}`,
						headers: {
							host: 'interface3.music.163.com',
							'x-aeapi': 'true',
							'x-test-seq': String(i),
							cookie: secret,
							'content-type': 'application/x-www-form-urlencoded',
						},
					},
					(res) => {
						const chunks = [];
						res.on('data', (chunk) => chunks.push(chunk));
						res.on('error', reject);
						res.on('end', () => {
							results[i] = {
								status: res.statusCode,
								headers: res.rawHeaders,
								body: Buffer.concat(chunks),
							};
							resolve();
						});
					}
				);
				req.setTimeout(3000, () =>
					req.destroy(Error('Client timeout'))
				);
				req.on('error', reject);
				req.end(inputs[i]);
			});
		const started = Date.now();
		for (let i = 0; i < 200; i++) await send(i);
		let next = 200;
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				while (next < size) {
					const i = next++;
					await send(i);
				}
			})
		);
		await sleep(100);
		for (let i = 0; i < size; i++)
			assert.equal(forwarded[i].body.toString(), inputs[i]);
		const batchText = fs.existsSync(batch)
			? fs.readFileSync(batch, 'utf8')
			: '';
		if (enabled && !failWrite) {
			const entry = JSON.parse(batchText.trim().split(/\r?\n/)[0]);
			assert.deepEqual(
				Object.keys(entry).sort(),
				[
					'apiPath',
					'examinedCount',
					'matchedFailureCount',
					'patchedCount',
					'matcherFailedCount',
					'skippedNoIdCount',
				].sort()
			);
			assert.equal(entry.apiPath, '/api/song/enhance/player/url/v1');

			assert.equal(batchText.includes(secret), false);
		} else assert.equal(batchText, '');
		console.log(
			'PASS ' +
				name +
				': ' +
				size +
				' requests (200 consecutive + 160 with concurrency=8), ' +
				(Date.now() - started) +
				' ms'
		);
		return { results, forwarded };
	} finally {
		agent.destroy();
		if (child && child.exitCode === null) {
			child.kill();
			await new Promise((resolve) => child.once('exit', resolve));
		}
		await new Promise((resolve) => upstream.close(resolve));
	}
}
(async () => {
	const baseline = await run('phase-six', baselinePath, false);
	for (const [name, enabled, fail, mode] of [
		['fixed-off', false, false],
		['fixed-on', true, false],
		['fixed-write-failure', true, true],
		['source-matcher-throw', true, false, 'throw'],
		['source-matcher-success', true, false, 'success'],
	]) {
		const actual = await run(
			name,
			path.join(root, mode ? 'src/app.js' : 'precompiled/app.js'),
			enabled,
			fail,
			mode
		);
		for (let i = 0; i < size; i++) {
			const f = responses[i],
				changes =
					mode === 'success' &&
					paths[i % paths.length] ===
						'/api/song/enhance/player/url/v1' &&
					f.status === 200 &&
					f.json.code === 200 &&
					!f.corrupt &&
					f.json.data[0].code === 404;
			if (!changes)
				assert.deepEqual(
					actual.results[i],
					baseline.results[i],
					name + ': exact response ' + i
				);
			else {
				const expected = JSON.parse(JSON.stringify(f.json));
				Object.assign(expected.data[0], {
					url: `https://music.163.com/package/${crypto.base64.encode('https://replacement/audio')}/123.mp3`,
					br: 320000,
					md5: 'hash',
					size: 1234,
					type: 'mp3',
					code: 200,
					freeTrialInfo: null,
				});
				const decoded = await decodeResponse(
					actual.results[i].body,
					f.encoding
				);
				assert.deepEqual(decoded.json, expected);
				assert.equal(decoded.gzip, f.inner);
				const norm = (r) => ({
					...r,
					body: null,
					headers: r.headers.map((v, k, a) =>
						k % 2 === 1 &&
						a[k - 1].toLowerCase() === 'content-length'
							? 'LENGTH'
							: v
					),
				});
				assert.deepEqual(
					norm(actual.results[i]),
					norm(baseline.results[i])
				);
			}
		}

		assert.deepEqual(
			actual.forwarded,
			baseline.forwarded,
			name + ': upstream request differs'
		);
		console.log(
			'PASS ' +
				name +
				': exact unmodified responses/upstream requests vs Stage 6; successful patches validated when using test-only source matcher.'
		);
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
