const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { decodeResponse } = require('../src/xeapi');
const crypto = require('../src/crypto');
const root = path.resolve(__dirname, '..'),
	secret = 'SECRET_NEVER_LOG',
	size = 360;
const baselinePath = process.argv[2] && path.resolve(process.argv[2]);
if (!baselinePath || !fs.existsSync(baselinePath))
	throw Error(
		'Usage: node scripts/privilege-regression.cjs PATH_TO_PHASE5_APP'
	);
if (
	require('node:crypto')
		.createHash('sha256')
		.update(fs.readFileSync(baselinePath))
		.digest('hex') !==
	'6ab09bae225247bd778624b33428838c970cc65af33bdd0d8e0c78f96c080aca'
)
	throw Error('Baseline SHA-256 must be the verified phase-five app.');
const directory = fs.mkdtempSync(
	path.join(require('node:os').tmpdir(), 'unm-batch-regression-')
);
const preload = path.join(directory, 'dns-preload.cjs');
fs.writeFileSync(
	preload,
	"require('dns').lookup=(host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}callback(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);};"
);
const listen = (s) =>
	new Promise((resolve) =>
		s.listen(0, '127.0.0.1', () => resolve(s.address().port))
	);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paths = [
	'/api/album/privilege',
	'/api/artist/top/song',
	'/api/v1/artist/top/song',
	'/api/search/complex/get',
	'/api/song/enhance/player/url',
];
const inputs = Array.from(
	{ length: size },
	(_, i) => 'B=' + secret + '&S=' + secret + '&R=' + i
);
const responses = inputs.map((_, i) => {
	const status = [200, 403, 500, 200, 200][i % 5];
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
	if (i % 3 === 1) gray.cp = 1;
	const json = {
		code: status,
		data: [gray, { ...gray, st: 0, pl: 999000 }],
		user: { token: secret },
	};
	const inner = i % 2 === 1;
	const encoding = [undefined, 'gzip', 'deflate', 'br'][
		Math.floor(i / 5) % 4
	];
	let raw = Buffer.from(JSON.stringify(json));
	if (inner) raw = zlib.gzipSync(raw);
	let body = crypto.eapi.encrypt(raw);
	const corrupt = i % 17 === 0;
	if (corrupt) body = Buffer.from('invalid ciphertext');
	if (encoding === 'gzip') body = zlib.gzipSync(body);
	if (encoding === 'deflate') body = zlib.deflateSync(body);
	if (encoding === 'br') body = zlib.brotliCompressSync(body);
	const patched = JSON.parse(JSON.stringify(json));
	const changes =
		status === 200 && i % paths.length === 0 && gray.cp === 0 && !corrupt;
	if (changes)
		Object.assign(patched.data[0], {
			st: 0,
			cp: 1,
			sp: 7,
			subp: 1,
			pl: 999000,
			dl: 999000,
			plLevel: 'exhigh',
			dlLevel: 'exhigh',
		});
	return { status, body, encoding, inner, json, patched, changes };
});
async function run(name, app, enabled, failWrite = false) {
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
			UNM_BATCH_OBSERVER: 'false',
			UNM_PRIVILEGE_OBSERVER: 'false',
			UNM_PRIVILEGE_VALUE_OBSERVER: 'false',
			UNM_XEAPI_PRIVILEGE_PATCH: String(enabled),
			UNM_XEAPI_PRIVILEGE_PATCH_LOG_FILE: failWrite ? directory : batch,
			SIGN_CERT: path.join(root, 'server.crt'),
			SIGN_KEY: path.join(root, 'server.key'),
		};
		delete env.NETEASE_COOKIE;
		child = spawn(
			process.execPath,
			[
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
			assert.deepEqual(Object.keys(entry).sort(), [
				'apiPath',
				'examinedCount',
				'patchedCount',
			]);
			assert.equal(entry.apiPath, '/api/album/privilege');
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
	const baseline = await run('phase-five', baselinePath, false);
	for (const [name, enabled, fail] of [
		['fixed-off', false, false],
		['fixed-on', true, false],
		['fixed-write-failure', true, true],
	]) {
		const actual = await run(
			name,
			path.join(root, 'precompiled/app.js'),
			enabled,
			fail
		);
		for (let i = 0; i < size; i++) {
			const expected = responses[i];
			if (!enabled || !expected.changes)
				assert.deepEqual(
					actual.results[i],
					baseline.results[i],
					name + ': nonpatched response differs ' + i
				);
			else {
				assert.equal(
					actual.results[i].status,
					baseline.results[i].status
				);
				const normalize = (entry) =>
					entry.headers.map((value, k, headers) =>
						k % 2 === 1 &&
						headers[k - 1].toLowerCase() === 'content-length'
							? 'LENGTH'
							: value
					);
				assert.deepEqual(
					normalize(actual.results[i]),
					normalize(baseline.results[i])
				);
				const decoded = await decodeResponse(
					actual.results[i].body,
					expected.encoding
				);
				assert.deepEqual(decoded.json, expected.patched);
				assert.equal(decoded.gzip, expected.inner);
				const idx = actual.results[i].headers.indexOf('content-length');
				assert.equal(
					Number(actual.results[i].headers[idx + 1]),
					actual.results[i].body.length
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
				': unchanged requests and nonmatching responses; only specified JSON fields and content-length change on matching responses.'
		);
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
