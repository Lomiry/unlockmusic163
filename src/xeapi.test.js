const { Readable, Writable } = require('stream');
const { once } = require('events');
const zlib = require('zlib');
const crypto = require('./crypto');
const { observeResponse } = require('./xeapi');

jest.mock('./logger', () => ({
	logScope: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('./provider/match', () =>
	jest.fn(() => {
		throw new Error('XEAPI must not match providers');
	})
);
const hook = require('./hook');
const match = require('./provider/match');

const SECRET = 'SECRET_DO_NOT_LOG';
const plaintext = (code = 200) =>
	Buffer.from(JSON.stringify({ code, token: SECRET, data: { ids: SECRET } }));
const encrypted = (gzip = false, code = 200) =>
	crypto.eapi.encrypt(
		gzip ? zlib.gzipSync(plaintext(code)) : plaintext(code)
	);
const tick = () => new Promise((resolve) => setImmediate(resolve));

const responseFor = (body, headers = {}, status = 200) => {
	const response = Readable.from(
		Array.from({ length: Math.ceil(body.length / 13) }, (_, i) =>
			body.subarray(i * 13, (i + 1) * 13)
		)
	);
	response.headers = {
		'content-length': String(body.length),
		'x-encr-ssid': SECRET,
		'x-encr-sskey': SECRET,
		'set-cookie': SECRET,
		...headers,
	};
	response.statusCode = status;
	return response;
};

async function observe(body, headers = {}, status = 200) {
	const response = responseFor(body, headers, status);
	const originalHeaders = { ...response.headers };
	const headerIdentity = response.headers;
	const logs = [];
	let terminal;
	const completed = new Promise((resolve) => {
		terminal = resolve;
	});
	const logger = {
		info: (fields, message) => {
			logs.push({ fields, message });
			if (message !== 'NCM XEAPI response') terminal();
		},
	};
	observeResponse(response, '/api/album/play', logger);
	// Delayed downstream attachment must not lose the first bytes.
	await tick();
	expect(response.readableFlowing).toBe(false);
	const received = [];
	const client = new Writable({
		highWaterMark: 1,
		write(chunk, _, callback) {
			received.push(Buffer.from(chunk));
			setImmediate(callback);
		},
	});
	const done = once(client, 'finish');
	response.pipe(client);
	await Promise.all([done, completed]);
	await tick();
	expect(Buffer.concat(received)).toEqual(body);
	expect(response.headers).toBe(headerIdentity);
	expect(response.headers).toEqual(originalHeaders);
	expect(response.statusCode).toBe(status);
	expect(response.body).toBeUndefined();
	expect(JSON.stringify(logs)).not.toContain(SECRET);
	expect(logs[0].fields).toEqual({
		apiPath: '/api/album/play',
		status,
		hasEncrSsid: true,
		hasEncrSskey: true,
	});
	return logs;
}

describe('XEAPI passive response observation', () => {
	test.each([false, true])(
		'decrypts AES with inner gzip=%s, preserves all bytes and headers',
		async (gzip) => {
			const logs = await observe(encrypted(gzip));
			expect(logs[1]).toEqual({
				message: 'NCM XEAPI decoded response',
				fields: { apiPath: '/api/album/play', code: 200, gzip },
			});
		}
	);
	test.each(['gzip', 'deflate', 'br'])(
		'handles HTTP content-encoding=%s on a diagnostic copy',
		async (encoding) => {
			const compress = {
				gzip: zlib.gzipSync,
				deflate: zlib.deflateSync,
				br: zlib.brotliCompressSync,
			}[encoding];
			const logs = await observe(compress(encrypted(true)), {
				'content-encoding': encoding,
			});
			expect(logs[1].fields).toEqual({
				apiPath: '/api/album/play',
				code: 200,
				gzip: true,
			});
		}
	);
	test.each([302, 403, 500])(
		'records HTTP %s without rewriting or dropping the body',
		async (status) => {
			const logs = await observe(
				Buffer.from(SECRET),
				{ location: 'https://example.invalid/?token=' + SECRET },
				status
			);
			expect(logs[1].message).toBe('NCM XEAPI decode failed');
		}
	);
	test('does not log a string-valued JSON code', async () => {
		const logs = await observe(encrypted(false, SECRET));
		expect(logs[1].fields.code).toBeNull();
	});
	test.each([
		Buffer.alloc(0),
		Buffer.from([1]),
		crypto.eapi.encrypt(Buffer.from('{"token":"' + SECRET)),
		crypto.eapi.encrypt(Buffer.from([0x1f, 0x8b, 0x00])),
	])(
		'handles empty/corrupt/encrypted malformed data safely (%#)',
		async (body) => {
			const logs = await observe(body);
			expect(logs[1].message).toBe(
				body.length
					? 'NCM XEAPI decode failed'
					: 'NCM XEAPI observation skipped'
			);
		}
	);
	test('bounds decoded gzip size', async () => {
		const body = crypto.eapi.encrypt(
			zlib.gzipSync(Buffer.from(' '.repeat(1024 * 1024 + 1)))
		);
		const logs = await observe(body);
		expect(logs[1].message).toBe('NCM XEAPI decode failed');
	});
	test('bounds captured size while forwarding the entire oversized response', async () => {
		const logs = await observe(Buffer.alloc(1024 * 1024 + 1), {}, 503);
		expect(logs[1].fields.reason).toBe('size_limit');
	}, 15000);
	test('caps concurrent captures and releases them after premature closes', async () => {
		const responses = Array.from({ length: 9 }, () =>
			responseFor(encrypted())
		);
		const logs = [];
		const logger = {
			info: (fields, message) => logs.push({ fields, message }),
		};
		for (const response of responses)
			observeResponse(response, '/api/test', logger);
		expect(
			logs.filter((log) => log.fields.reason === 'capture_busy')
		).toHaveLength(1);
		for (const response of responses) response.destroy();
		await tick();
		expect(
			logs.filter((log) => log.fields.reason === 'stream_closed')
		).toHaveLength(8);
		const successful = await observe(encrypted());
		expect(successful[1].message).toBe('NCM XEAPI decoded response');
	});
	test.each(['aborted', 'error'])(
		'cleans up on %s and preserves existing listeners',
		async (event) => {
			const response = responseFor(encrypted());
			const existingErrorListener = jest.fn();
			response.on('error', existingErrorListener);
			const logger = { info: jest.fn() };
			observeResponse(response, '/api/test', logger);
			response.emit(event, new Error(SECRET));
			expect(response.listeners('error')).toContain(
				existingErrorListener
			);
			expect(response.listenerCount('data')).toBe(0);
			expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
				SECRET
			);
			response.destroy();
			await tick();
		}
	);
	test('reports header existence even for empty values without storing their values', async () => {
		const response = responseFor(encrypted());
		delete response.headers['x-encr-ssid'];
		response.headers['x-encr-sskey'] = '';
		const logger = { info: jest.fn() };
		observeResponse(response, '/api/test', logger);
		expect(logger.info.mock.calls[0][0]).toMatchObject({
			hasEncrSsid: false,
			hasEncrSskey: true,
		});
		response.destroy();
		await tick();
	});
});

describe('XEAPI hook isolation', () => {
	test('maps only internal metadata, never reads B/S/R or invokes response patching', async () => {
		const req = {
			method: 'POST',
			url: '/xeapi/song/enhance/player/url/v1?token=' + SECRET,
			headers: {
				host: 'interface3.music.163.com',
				'x-aeapi': 'true',
				'x-client-enc-state': SECRET,
				cookie: SECRET,
			},
			socket: { encrypted: true },
			readable: true,
		};
		const originalHeaders = { ...req.headers };
		const ctx = { req };
		await hook.request.before(ctx);
		expect(ctx.xeapi).toEqual({
			apiPath: '/api/song/enhance/player/url/v1',
		});
		expect(ctx.netease).toBeUndefined();
		expect(req.headers).toEqual(originalHeaders);
		expect(req.body).toBeUndefined();
		expect(req.readable).toBe(true);
		expect(req.url).toContain('/xeapi/');
		const body = encrypted(true);
		ctx.proxyRes = responseFor(body);
		await hook.request.after(ctx);
		const received = [];
		const client = new Writable({
			write(chunk, _, callback) {
				received.push(Buffer.from(chunk));
				callback();
			},
		});
		const done = once(client, 'finish');
		ctx.proxyRes.pipe(client);
		await done;
		expect(Buffer.concat(received)).toEqual(body);
		expect(match).not.toHaveBeenCalled();
		await tick();
	});
	test('does not recognize unrelated hosts as XEAPI', async () => {
		const ctx = {
			req: {
				method: 'POST',
				url: 'http://example.org/xeapi/album/play',
				headers: { host: 'example.org' },
				socket: {},
			},
		};
		await hook.request.before(ctx);
		expect(ctx.xeapi).toBeUndefined();
	});
});

describe('router observation fast path', () => {
	const { shouldObserveResponse } = require('./xeapi');
	test('ordinary XEAPI requests do not attach capture listeners when diagnostics are off', () => {
		const response = responseFor(encrypted());
		const ctx = {
			req: { headers: {} },
			proxyRes: response,
			xeapi: { apiPath: '/api/test' },
		};
		hook.request.after(ctx);
		expect(ctx.proxyRes).toBe(response);
		expect(response.listenerCount('data')).toBe(0);
		expect(response.readableFlowing).toBe(null);
		response.destroy();
	});
	test.each([
		['UNM_ALBUM_PLAY_OBSERVER', '/api/song/enhance/player/url/v1'],
		['UNM_PRIVILEGE_OBSERVER', '/api/album/privilege'],
		['UNM_PRIVILEGE_VALUE_OBSERVER', '/api/album/privilege'],
	])('keeps %s active only on its target response', (key, target) => {
		expect(shouldObserveResponse(target, { [key]: 'true' })).toBe(true);
		expect(shouldObserveResponse('/api/unrelated', { [key]: 'true' })).toBe(
			false
		);
	});
	test('explicit XEAPI diagnostics can still observe every path', () => {
		expect(
			shouldObserveResponse('/api/test', { UNM_XEAPI_OBSERVER: 'true' })
		).toBe(true);
		expect(shouldObserveResponse('/api/test', {})).toBe(false);
	});
	test('enabled observers allocate a small buffer for small responses', async () => {
		const body = encrypted();
		const allocate = jest.spyOn(Buffer, 'allocUnsafe');
		try {
			await observe(body);
			expect(allocate.mock.calls.some(([size]) => size === 4096)).toBe(
				true
			);
			expect(
				allocate.mock.calls.some(([size]) => size === 1024 * 1024)
			).toBe(false);
		} finally {
			allocate.mockRestore();
		}
	});
});

test.each([
	'/api/album/v3/detail',
	'/api/v1/artist/top/song',
	'/api/artist/top/song',
	'/api/search/complex/get',
	'/api/v3/search/suggest',
])('preserves privilege observer coverage for %s', (apiPath) => {
	expect(
		require('./xeapi').shouldObserveResponse(apiPath, {
			UNM_PRIVILEGE_OBSERVER: 'true',
		})
	).toBe(true);
});
test('growing observation buffers preserve responses spanning multiple capacity boundaries', async () => {
	const body = crypto.eapi.encrypt(
		Buffer.from(JSON.stringify({ code: 200, data: 'x'.repeat(20000) }))
	);
	const logs = await observe(body);
	expect(logs[1].message).toBe('NCM XEAPI decoded response');
});
