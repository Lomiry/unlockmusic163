const { Readable, PassThrough } = require('stream');
const zlib = require('zlib');
const crypto = require('./crypto');
const { decodeResponse } = require('./xeapi');
const {
	patchJson,
	transformBody,
	createResponsePatch,
	createPatchLog,
	createBoundedMatcher,
} = require('./xeapi-player-url-patch');
const PATH = '/api/song/enhance/player/url/v1';
const gray = (id = 123) => ({
	id,
	code: 404,
	url: null,
	br: 0,
	fee: 0,
	payed: 0,
	flag: 8,
	freeTrialInfo: null,
	level: null,
	type: null,
	encodeType: null,
	message: 'SECRET',
});
const normal = () => ({
	...gray(),
	code: 200,
	url: 'http://original',
	br: 256003,
	type: 'm4a',
});
const song = {
	url: 'https://replacement/audio',
	br: 999000,
	md5: 'hash',
	size: 1234,
};
const matcher = async () => song;
const wire = (json, inner, outer) => {
	let b = Buffer.from(JSON.stringify(json));
	if (inner) b = zlib.gzipSync(b);
	b = crypto.eapi.encrypt(b);
	if (outer === 'gzip') b = zlib.gzipSync(b);
	if (outer === 'deflate') b = zlib.deflateSync(b);
	if (outer === 'br') b = zlib.brotliCompressSync(b);
	return b;
};
const collect = async (s) => {
	const chunks = [];
	for await (const c of s) chunks.push(c);
	return Buffer.concat(chunks);
};
const ctx = (body, encoding) => {
	const s = Readable.from([body.subarray(0, 11), body.subarray(11)]);
	s.statusCode = 200;
	s.headers = {
		'content-length': String(body.length),
		'x-fixture': 'SECRET',
		...(encoding ? { 'content-encoding': encoding } : {}),
	};
	return { proxyRes: s, xeapi: { apiPath: PATH } };
};
const unchanged = async (c, options) => {
	const s = c.proxyRes,
		headers = { ...s.headers },
		status = s.statusCode;
	const body = options.body;
	await createResponsePatch({ enabled: true, ...options })(c);
	expect(c.proxyRes.statusCode).toBe(status);
	expect(c.proxyRes.headers).toEqual(headers);
	expect(await collect(c.proxyRes)).toEqual(body);
};
test('minimal copy and non-PC package semantics; input preserved', async () => {
	const json = { code: 200, data: [gray(), normal()] },
		before = JSON.stringify(json);
	const result = await patchJson(json, {
		matcher,
		endpoint: 'https://proxy',
	});
	expect(result.json.data[0]).toEqual({
		...gray(),
		url: `https://proxy/package/${crypto.base64.encode(song.url)}/123.flac`,
		type: 'flac',
		md5: 'hash',
		br: 999000,
		size: 1234,
		code: 200,
	});
	expect(result.json.data[1]).toBe(json.data[1]);
	expect(JSON.stringify(json)).toBe(before);
	expect(result).toMatchObject({
		examinedCount: 2,
		matchedFailureCount: 1,
		patchedCount: 1,
		matcherFailedCount: 0,
		skippedNoIdCount: 0,
	});
});
test('traditional fallback MD5/bitrate/type', async () => {
	const r = await patchJson(
		{ code: 200, data: [gray()] },
		{ matcher: async () => ({ url: song.url, size: 9 }), endpoint: null }
	);
	expect(r.json.data[0]).toMatchObject({
		url: song.url,
		type: 'mp3',
		md5: crypto.md5.digest(song.url),
		br: 128000,
		size: 9,
	});
});
test.each([
	undefined,
	null,
	0,
	-1,
	1.5,
	'abc',
	'0',
	'01',
	'9007199254740992',
	{},
	true,
])('invalid id %s leaves item unchanged', async (id) => {
	const item = { ...gray(), id },
		fn = jest.fn(matcher);
	const r = await patchJson({ code: 200, data: [item] }, { matcher: fn });
	expect(r.json.data[0]).toBe(item);
	expect(fn).not.toHaveBeenCalled();
	expect(r.skippedNoIdCount).toBe(1);
});
test.each([
	{ code: '404' },
	{ code: 200 },
	{ url: '' },
	{ url: 'http://original' },
	{ br: 1 },
	{ br: '0' },
])('strict failure signature %s', async (change) => {
	const item = { ...gray(), ...change },
		fn = jest.fn(matcher);
	const r = await patchJson({ code: 200, data: [item] }, { matcher: fn });
	expect(r.json.data[0]).toBe(item);
	expect(fn).not.toHaveBeenCalled();
});
test('partial success and duplicate normalized IDs including failure', async () => {
	const fn = jest.fn(async (id) => {
		if (Number(id) === 2) throw Error('SECRET');
		return song;
	});
	const r = await patchJson(
		{ code: 200, data: [gray(1), gray('1'), gray(2), gray(2)] },
		{ matcher: fn }
	);
	expect(fn).toHaveBeenCalledTimes(2);
	expect(r.patchedCount).toBe(2);
	expect(r.matcherFailedCount).toBe(2);
	expect(r.json.data[2]).toEqual(gray(2));
});
test.each([false, true])(
	'inner gzip=%s and all HTTP encodings',
	async (inner) => {
		for (const outer of [undefined, 'identity', 'gzip', 'deflate', 'br']) {
			const body = wire(
					{ code: 200, data: [gray(), normal()] },
					inner,
					outer
				),
				c = ctx(body, outer);
			await createResponsePatch({
				enabled: true,
				transform: (b, e) => transformBody(b, e, { matcher }),
			})(c);
			const output = await collect(c.proxyRes),
				decoded = await decodeResponse(output, outer);
			expect(decoded.gzip).toBe(inner);
			expect(decoded.json.data[0].code).toBe(200);
			expect(decoded.json.data[1]).toEqual(normal());
			expect(c.proxyRes.headers['content-length']).toBe(
				String(output.length)
			);
		}
	}
);
test.each([false, true])(
	'all unchanged cases byte exact, inner=%s',
	async (inner) => {
		for (const encoding of [undefined, 'identity', 'gzip', 'deflate', 'br'])
			for (const input of [
				{ code: 403, data: [gray()] },
				{ code: 200, data: {} },
				{ code: 200, data: [normal()] },
				{ code: 200, data: [{ ...gray(), id: null }] },
				{ code: 200, data: [gray()] },
			]) {
				const body = wire(input, inner, encoding);
				await unchanged(ctx(body, encoding), {
					body,
					transform: (b, e) =>
						transformBody(b, e, {
							matcher: async () => {
								throw Error('SECRET');
							},
						}),
				});
			}
	}
);
test.each([
	'off',
	'other',
	'non-v1',
	'non200',
	'etag',
	'content-md5',
	'digest',
	'content-digest',
	'repr-digest',
	'content-range',
	'trailer',
	'large',
	'encoding',
])('skip %s preserves status headers ciphertext', async (kind) => {
	const body = wire({ code: 200, data: [gray()] }),
		c = ctx(body),
		options = { body };
	if (kind === 'off') options.enabled = false;
	else if (kind === 'other') c.xeapi.apiPath = '/api/album/privilege';
	else if (kind === 'non-v1')
		c.xeapi.apiPath = '/api/song/enhance/player/url';
	else if (kind === 'non200') c.proxyRes.statusCode = 206;
	else if (kind === 'large') c.proxyRes.headers['content-length'] = '1048577';
	else if (kind === 'encoding')
		c.proxyRes.headers['content-encoding'] = 'unknown';
	else c.proxyRes.headers[kind] = 'SECRET';
	await unchanged(c, options);
});
test.each([
	'decode',
	'encrypt',
	'compress',
	'transform',
	'malformed',
	'overflow',
	'timeout',
])('fail-open %s byte exact', async (kind) => {
	const body =
		kind === 'malformed'
			? Buffer.from('broken')
			: wire({ code: 200, data: [gray()] }, true, 'gzip');
	const options = { body },
		deps = { matcher };
	if (kind === 'decode')
		deps.decode = async () => {
			throw Error('SECRET');
		};
	if (kind === 'encrypt')
		deps.encrypt = () => {
			throw Error('SECRET');
		};
	if (kind === 'compress')
		deps.compress = {
			gzip: async () => {
				throw Error('SECRET');
			},
		};
	options.transform = (b, e) => transformBody(b, e, deps);
	if (kind === 'transform')
		options.transform = async () => {
			throw Error('SECRET');
		};
	if (kind === 'overflow') {
		options.maxBytes = 10;
	}
	if (kind === 'timeout') {
		options.timeoutMs = 10;
		options.transform = () => new Promise(() => {});
	}
	const c = ctx(body, 'gzip');
	if (kind === 'overflow') delete c.proxyRes.headers['content-length'];
	await unchanged(c, options);
});
test('timeout prefix/tail and response capacity', async () => {
	const s = new PassThrough();
	s.headers = {};
	s.statusCode = 200;
	const c = { proxyRes: s, xeapi: { apiPath: PATH } },
		patch = createResponsePatch({
			enabled: true,
			maxConcurrent: 1,
			timeoutMs: 10,
		});
	const pending = patch(c),
		body = wire({ code: 200, data: [normal()] }),
		second = ctx(body);
	expect(patch(second)).toBeUndefined();
	expect(await collect(second.proxyRes)).toEqual(body);
	s.write(Buffer.from('prefix'));
	await pending;
	const received = collect(c.proxyRes);
	s.end(Buffer.from('tail'));
	expect(await received).toEqual(Buffer.from('prefixtail'));
});
test('hung matcher capacity is held until settlement', async () => {
	let done;
	const fn = jest.fn(() => new Promise((r) => (done = r))),
		bounded = createBoundedMatcher(fn, 1);
	const pending = bounded(1);
	await expect(bounded(2)).rejects.toThrow('capacity');
	expect(fn).toHaveBeenCalledTimes(1);
	done(song);
	await pending;
});
test('log safe allowlist and write/defer/diagnostic failure isolated', async () => {
	const writes = [];
	createPatchLog({
		enabled: true,
		defer: (f) => f(),
		appendFile: (_, line, cb) => {
			writes.push(JSON.parse(line));
			cb();
		},
	})({ ...gray(), examinedCount: 2, patchedCount: 1, url: 'SECRET' });
	expect(writes).toEqual([
		{
			apiPath: PATH,
			examinedCount: 2,
			matchedFailureCount: 0,
			patchedCount: 1,
			matcherFailedCount: 0,
			skippedNoIdCount: 0,
		},
	]);
	for (const options of [
		{
			defer: () => {
				throw Error('SECRET');
			},
		},
		{
			defer: (f) => f(),
			appendFile: () => {
				throw Error('SECRET');
			},
		},
	])
		expect(() =>
			createPatchLog({ enabled: true, ...options })({})
		).not.toThrow();
	const body = wire({ code: 200, data: [normal()] });
	await unchanged(ctx(body), {
		body,
		diagnostic: () => {
			throw Error('SECRET');
		},
	});
});
