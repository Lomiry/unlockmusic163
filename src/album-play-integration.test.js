const { Readable, Writable } = require('stream');
const { once } = require('events');
const zlib = require('zlib');
const crypto = require('./crypto');
jest.mock('./album-play-observer', () => ({
	scheduleAlbumPlayObservation: jest.fn(),
}));
const { scheduleAlbumPlayObservation } = require('./album-play-observer');
const { observeResponse } = require('./xeapi');
test.each([false, true])(
	'observer throw leaves ciphertext/headers/decode unchanged inner gzip=%s',
	async (gzip) => {
		const json = { code: 200, data: { url: 'https://SECRET', br: 320000 } };
		const plain = Buffer.from(JSON.stringify(json));
		const body = crypto.eapi.encrypt(gzip ? zlib.gzipSync(plain) : plain);
		const response = Readable.from([body.subarray(0, 5), body.subarray(5)]);
		response.statusCode = 200;
		response.headers = {
			'content-length': String(body.length),
			'x-encr-ssid': 'SECRET',
		};
		const headers = { ...response.headers },
			received = [],
			logs = [];
		let complete;
		const done = new Promise((resolve) => {
			complete = resolve;
		});
		scheduleAlbumPlayObservation.mockImplementation((path, decoded) => {
			expect(path).toBe('/api/song/enhance/player/url/v1');
			expect(decoded).toEqual(json);
			complete();
			throw Error('SECRET');
		});
		observeResponse(response, '/api/song/enhance/player/url/v1', {
			info: (fields, msg) => logs.push({ fields, msg }),
		});
		const sink = new Writable({
			write(chunk, _, cb) {
				received.push(Buffer.from(chunk));
				cb();
			},
		});
		const finish = once(sink, 'finish');
		response.pipe(sink);
		await Promise.all([done, finish]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(Buffer.concat(received)).toEqual(body);
		expect(response.headers).toEqual(headers);
		expect(logs.map((x) => x.msg)).toEqual([
			'NCM XEAPI response',
			'NCM XEAPI decoded response',
		]);
		expect(JSON.stringify(logs)).not.toContain('SECRET');
	}
);
