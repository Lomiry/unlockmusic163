const { Readable, PassThrough } = require('stream');
const zlib = require('zlib');
const crypto = require('./crypto');
const { decodeResponse } = require('./xeapi');
const {
	patchJson,
	transformBody,
	createResponsePatch,
	createPatchLog,
} = require('./xeapi-privilege-patch');
const PATH = '/api/album/privilege';
const gray = () => ({
	id: 123,
	name: 'SECRET',
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
});
const json = () => ({
	code: 200,
	data: [gray(), { ...gray(), st: 0, pl: 999000 }],
	extra: 'SECRET',
});
const expected = (input) => {
	const copy = JSON.parse(JSON.stringify(input));
	Object.assign(copy.data[0], {
		st: 0,
		pl: 999000,
		dl: 999000,
		sp: 7,
		cp: 1,
		subp: 1,
		plLevel: 'exhigh',
		dlLevel: 'exhigh',
	});
	return copy;
};
const wire = (input, inner, outer) => {
	let b = Buffer.from(JSON.stringify(input));
	if (inner) b = zlib.gzipSync(b);
	b = crypto.eapi.encrypt(b);
	if (outer === 'gzip') b = zlib.gzipSync(b);
	if (outer === 'deflate') b = zlib.deflateSync(b);
	if (outer === 'br') b = zlib.brotliCompressSync(b);
	return b;
};
const collect = async (source) => {
	const chunks = [];
	for await (const chunk of source) chunks.push(chunk);
	return Buffer.concat(chunks);
};
const ctx = (body) => {
	const source = Readable.from([body.subarray(0, 11), body.subarray(11)]);
	source.statusCode = 200;
	source.headers = {
		'content-length': String(body.length),
		'x-unchanged': 'SECRET',
	};
	return { proxyRes: source, xeapi: { apiPath: PATH } };
};
test('only specified fields change; original decoded JSON stays unchanged', () => {
	const input = json(),
		before = JSON.stringify(input),
		result = patchJson(input);
	expect(result.json).toEqual(expected(input));
	expect(result.examinedCount).toBe(2);
	expect(result.patchedCount).toBe(1);
	expect(JSON.stringify(input)).toBe(before);
});
test.each(['st', 'pl', 'dl', 'sp', 'cp', 'subp'])(
	'requires all six conditions: %s',
	(key) => {
		const item = gray();
		item[key] = key === 'st' ? 0 : 1;
		expect(patchJson({ code: 200, data: [item] }).patchedCount).toBe(0);
	}
);
test.each([
	undefined,
	0,
	-1,
	3.5,
	'999000',
	Infinity,
	Number.MAX_SAFE_INTEGER + 1,
])('invalid maximum %s uses fallback', (value) => {
	const item = gray();
	item.playMaxbr = item.downloadMaxbr = value;
	const patched = patchJson({ code: 200, data: [item] }).json.data[0];
	expect(patched.pl).toBe(320000);
	expect(patched.dl).toBe(320000);
});
test('missing and non-none levels are preserved', () => {
	const item = gray();
	delete item.plLevel;
	item.dlLevel = 'hires';
	const result = patchJson({ code: 200, data: [item] }).json.data[0];
	expect(result).not.toHaveProperty('plLevel');
	expect(result.dlLevel).toBe('hires');
});
test.each([
	null,
	{},
	{ code: 403, data: [gray()] },
	{ code: 200, data: {} },
	{ code: 200, data: Array(513).fill(gray()) },
])('unexpected or oversized JSON is skipped', (input) => {
	expect(patchJson(input)).toBe(null);
});
test.each([false, true])(
	'AES and inner gzip=%s round trip for every outer encoding',
	async (inner) => {
		for (const outer of [undefined, 'identity', 'gzip', 'deflate', 'br']) {
			const input = json(),
				body = wire(input, inner, outer),
				result = await transformBody(body, outer),
				decoded = await decodeResponse(result.body, outer);
			expect(decoded.json).toEqual(expected(input));
			expect(decoded.gzip).toBe(inner);
			expect(result.patchedCount).toBe(1);
		}
	}
);
test('nonmatching JSON preserves exact ciphertext for all gzip combinations', async () => {
	for (const inner of [false, true])
		for (const outer of [undefined, 'gzip']) {
			const input = json();
			input.data[0].cp = 1;
			const body = wire(input, inner, outer);
			expect((await transformBody(body, outer)).body).toBe(body);
		}
});
test.each(['decode', 'encrypt', 'compress'])(
	'failure in %s returns original body',
	async (stage) => {
		const body = wire(json(), true, 'gzip');
		const options =
			stage === 'decode'
				? {
						decode: async () => {
							throw Error('SECRET');
						},
					}
				: stage === 'encrypt'
					? {
							encrypt: () => {
								throw Error('SECRET');
							},
						}
					: {
							compress: {
								gzip: async () => {
									throw Error('SECRET');
								},
							},
						};
		expect((await transformBody(body, 'gzip', options)).body).toBe(body);
	}
);
test.each([
	Buffer.from('not encrypted'),
	crypto.eapi.encrypt(Buffer.from('not JSON')),
	crypto.eapi.encrypt(Buffer.from([0x1f, 0x8b, 1, 2])),
])('malformed response is fail-open', async (body) => {
	expect((await transformBody(body)).body).toBe(body);
});
test('default off keeps exact response object and consumes nothing', () => {
	const c = ctx(wire(json()));
	const original = c.proxyRes;
	expect(createResponsePatch()(c)).toBeUndefined();
	expect(c.proxyRes).toBe(original);
	expect(original.readableFlowing).toBe(null);
});
test.each([
	'/api/v1/artist/top/song',
	'/api/search/complex/page/v3',
	'/api/song/enhance/player/url',
	'/api/album/privilege?token=SECRET',
])('other API %s is untouched', (path) => {
	const c = ctx(wire(json()));
	c.xeapi.apiPath = path;
	expect(createResponsePatch({ enabled: true })(c)).toBeUndefined();
});
test.each([
	'etag',
	'content-md5',
	'digest',
	'content-digest',
	'repr-digest',
	'content-range',
	'trailer',
])('integrity header %s skips modification', (header) => {
	const c = ctx(wire(json()));
	c.proxyRes.headers[header] = 'SECRET';
	expect(createResponsePatch({ enabled: true })(c)).toBeUndefined();
});
test('changed response only updates content length and preserves status/other headers', async () => {
	const body = wire(json()),
		c = ctx(body),
		diagnostic = jest.fn();
	await createResponsePatch({ enabled: true, diagnostic })(c);
	const output = await collect(c.proxyRes);
	expect((await decodeResponse(output)).json).toEqual(expected(json()));
	expect(c.proxyRes.statusCode).toBe(200);
	expect(c.proxyRes.headers).toEqual({
		'content-length': String(output.length),
		'x-unchanged': 'SECRET',
	});
	expect(diagnostic).toHaveBeenCalledWith(2, 1);
});
test('chunked framing preserved without adding content-length', async () => {
	const c = ctx(wire(json()));
	delete c.proxyRes.headers['content-length'];
	c.proxyRes.headers['transfer-encoding'] = 'chunked';
	await createResponsePatch({ enabled: true, diagnostic: () => {} })(c);
	expect(c.proxyRes.headers).not.toHaveProperty('content-length');
	expect(c.proxyRes.headers['transfer-encoding']).toBe('chunked');
	await collect(c.proxyRes);
});
test('thrown transformation and diagnostics never affect original forwarding', async () => {
	const body = wire(json()),
		c = ctx(body),
		headers = c.proxyRes.headers;
	await createResponsePatch({
		enabled: true,
		transform: async () => {
			throw Error('SECRET');
		},
	})(c);
	expect(await collect(c.proxyRes)).toEqual(body);
	expect(c.proxyRes.headers).toBe(headers);
	const d = ctx(body);
	await createResponsePatch({
		enabled: true,
		diagnostic: () => {
			throw Error('SECRET');
		},
	})(d);
	expect((await decodeResponse(await collect(d.proxyRes))).json).toEqual(
		expected(json())
	);
});
test('decode deadline returns original finished body, late result is ignored', async () => {
	const body = wire(json()),
		c = ctx(body);
	let resolve;
	const late = new Promise((r) => {
		resolve = r;
	});
	await createResponsePatch({
		enabled: true,
		timeoutMs: 10,
		transform: () => late,
	})(c);
	const replay = c.proxyRes;
	expect(await collect(replay)).toEqual(body);
	resolve({ body: Buffer.from('bad'), patchedCount: 1 });
	await new Promise((r) => setImmediate(r));
	expect(c.proxyRes).toBe(replay);
});
test('stream timeout forwards captured prefix and remaining tail', async () => {
	const source = new PassThrough();
	source.statusCode = 200;
	source.headers = {};
	const c = { proxyRes: source, xeapi: { apiPath: PATH } };
	const pending = createResponsePatch({ enabled: true, timeoutMs: 10 })(c);
	source.write(Buffer.from('prefix'));
	await pending;
	const received = collect(c.proxyRes);
	source.end(Buffer.from('tail'));
	expect(await received).toEqual(Buffer.from('prefixtail'));
});
test('unknown-length overflow replays all bytes', async () => {
	const body = Buffer.alloc(100, 7),
		c = ctx(body);
	delete c.proxyRes.headers['content-length'];
	await createResponsePatch({ enabled: true, maxBytes: 10 })(c);
	expect(await collect(c.proxyRes)).toEqual(body);
});
test('known large length, unsupported encoding, non200 are skipped', () => {
	for (const alter of [
		(s) => {
			s.headers['content-length'] = '1048577';
		},
		(s) => {
			s.headers['content-encoding'] = 'unknown';
		},
		(s) => {
			s.statusCode = 403;
		},
	]) {
		const c = ctx(wire(json()));
		alter(c.proxyRes);
		expect(createResponsePatch({ enabled: true })(c)).toBeUndefined();
	}
});
test('concurrent capacity skips extra requests', async () => {
	const source = new PassThrough();
	source.headers = {};
	source.statusCode = 200;
	const patch = createResponsePatch({
		enabled: true,
		maxConcurrent: 1,
		timeoutMs: 10,
	});
	const first = patch({ proxyRes: source, xeapi: { apiPath: PATH } });
	expect(patch(ctx(wire(json())))).toBeUndefined();
	source.end(Buffer.from('bad'));
	await first;
});
test('independent bounded log records only apiPath and counts', () => {
	const jobs = [],
		writes = [];
	let time = 0;
	const log = createPatchLog({
		enabled: true,
		filePath: 'x',
		now: () => time,
		defer: (job) => jobs.push(job),
		appendFile: (_, line, cb) => {
			writes.push(JSON.parse(line));
			cb(null);
		},
	});
	for (let i = 0; i < 70; i++) {
		log(12, 12);
		log(12, 12);
		jobs.shift()?.();
		time += 1000;
	}
	expect(writes).toHaveLength(60);
	expect(writes[0]).toEqual({
		apiPath: PATH,
		examinedCount: 12,
		patchedCount: 12,
	});
});
test('log errors isolated and default off', () => {
	expect(() =>
		createPatchLog({
			enabled: true,
			filePath: 'x',
			defer: () => {
				throw Error('SECRET');
			},
		})(1, 1)
	).not.toThrow();
	const defer = jest.fn();
	createPatchLog({ filePath: 'x', defer })(1, 1);
	expect(defer).not.toHaveBeenCalled();
});
test('JSON serialization failure returns original ciphertext', async () => {
	const body = wire(json()),
		circular = json();
	circular.self = circular;
	expect(
		(
			await transformBody(body, undefined, {
				decode: async () => ({ json: circular, gzip: false }),
			})
		).body
	).toBe(body);
});
test('modification failure returns original ciphertext', async () => {
	const body = wire(json()),
		invalid = json();
	Object.defineProperty(invalid.data[0], 'st', {
		get() {
			throw Error('SECRET');
		},
	});
	expect(
		(
			await transformBody(body, undefined, {
				decode: async () => ({ json: invalid, gzip: false }),
			})
		).body
	).toBe(body);
});
test('outer gzip recompression failure returns original ciphertext', async () => {
	const body = wire(json(), false, 'gzip');
	expect(
		(
			await transformBody(body, 'gzip', {
				compress: {
					gzip: async () => {
						throw Error('SECRET');
					},
				},
			})
		).body
	).toBe(body);
});
