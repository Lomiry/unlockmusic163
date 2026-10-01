const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const crypto = require('../src/crypto');
const root = path.resolve(__dirname, '..'),
	secret = 'SECRET_NEVER_LOG',
	size = 360;
const baselinePath = process.argv[2] && path.resolve(process.argv[2]);
if (!baselinePath || !fs.existsSync(baselinePath))
	throw Error(
		'Usage: node scripts/privilege-regression.cjs PATH_TO_PHASE4_APP'
	);
if (
	require('node:crypto')
		.createHash('sha256')
		.update(fs.readFileSync(baselinePath))
		.digest('hex') !==
	'ca76eec09080bb35e80d6d8daeec7b1ec1eb879c4caba847ea95c0d27bd78dfb'
)
	throw Error('Baseline SHA-256 must be the verified phase-four app.');
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
	'/api/search/song/get',
];
const inputs = Array.from(
	{ length: size },
	(_, i) => 'B=' + secret + '&S=' + secret + '&R=' + i
);
const responses = inputs.map((_, i) => {
	const status = [200, 403, 500, 200, 200][i % 5];
	const json = Buffer.from(
		JSON.stringify({
			code: status,
			...(i % paths.length === 0
				? {
						data: [
							{ pl: 0, fee: 0, plLevel: 'none', id: secret },
							{ pl: 0, fee: 0, plLevel: 'none', name: secret },
							{ pl: 320000, plLevel: secret },
						],
					}
				: {
						songs: [
							{
								name: secret,
								privilege: { pl: 0, plLevel: 'none' },
							},
							{
								id: secret,
								privilege: { pl: 0, plLevel: 'none' },
							},
							{
								name: secret,
								privilege: { pl: 320000, plLevel: secret },
							},
						],
					}),
			user: { name: secret, token: secret },
			[secret]: { privileges: [{ downloadMaxbr: 0 }] },
		})
	);
	let body =
		status === 200
			? crypto.eapi.encrypt(i % 2 === 0 ? json : zlib.gzipSync(json))
			: json;
	const encoding = i % 5 === 4 ? 'gzip' : undefined;
	if (encoding) body = zlib.gzipSync(body);
	return { status, body, encoding };
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
			UNM_PRIVILEGE_VALUE_OBSERVER: String(enabled),
			UNM_PRIVILEGE_VALUE_LOG_FILE: failWrite ? directory : batch,
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
			assert.ok(batchText.includes('NCM XEAPI privilege values'));
			const entry = JSON.parse(batchText.trim().split(/\r?\n/)[0]);
			assert.equal(entry.elementCount, 3);
			assert.equal(entry.privilegeSignatures[0].count, 2);
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
	const baseline = await run('phase-four', baselinePath, false);
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
		assert.deepEqual(
			actual.results,
			baseline.results,
			name + ': response status/raw headers/body differ'
		);
		assert.deepEqual(
			actual.forwarded,
			baseline.forwarded,
			name + ': upstream request differs'
		);
		console.log(
			'PASS ' +
				name +
				': byte-identical response bodies/raw header arrays and upstream request bodies/headers vs phase-four.'
		);
	}
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
