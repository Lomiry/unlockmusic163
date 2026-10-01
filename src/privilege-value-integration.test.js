const { Readable, Writable } = require('stream');
const { once } = require('events');
const zlib = require('zlib');
const crypto = require('./crypto');
jest.mock('./privilege-observer', () => ({
	schedulePrivilegeObservation: jest.fn(),
}));
jest.mock('./privilege-value-observer', () => ({
	schedulePrivilegeValueObservation: jest.fn(),
}));
const { schedulePrivilegeObservation } = require('./privilege-observer');
const {
	schedulePrivilegeValueObservation,
} = require('./privilege-value-observer');
const { observeResponse } = require('./xeapi');
test.each([false, true])(
	'schema and value hook exceptions preserve stream and decode result (gzip=%s)',
	async (gzip) => {
		const secret = 'SECRET_NEVER_LOG';
		const json = { code: 200, data: [{ pl: 0, name: secret }] };
		const plain = Buffer.from(JSON.stringify(json));
		const body = crypto.eapi.encrypt(gzip ? zlib.gzipSync(plain) : plain);
		const response = Readable.from([body.subarray(0, 7), body.subarray(7)]);
		response.statusCode = 200;
		response.headers = {
			'content-length': String(body.length),
			'x-encr-ssid': secret,
		};
		const headers = { ...response.headers },
			logs = [],
			received = [];
		let complete;
		const done = new Promise((resolve) => {
			complete = resolve;
		});
		schedulePrivilegeObservation.mockImplementation(() => {
			throw Error(secret);
		});
		schedulePrivilegeValueObservation.mockImplementation(
			(path, decoded) => {
				expect(path).toBe('/api/album/privilege');
				expect(decoded).toEqual(json);
				complete();
				throw Error(secret);
			}
		);
		observeResponse(response, '/api/album/privilege', {
			info: (fields, msg) => logs.push({ fields, msg }),
		});
		const sink = new Writable({
			write(chunk, _, cb) {
				received.push(Buffer.from(chunk));
				cb();
			},
		});
		const finished = once(sink, 'finish');
		response.pipe(sink);
		await Promise.all([done, finished]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(Buffer.concat(received)).toEqual(body);
		expect(response.headers).toEqual(headers);
		expect(logs.map((log) => log.msg)).toEqual([
			'NCM XEAPI response',
			'NCM XEAPI decoded response',
		]);
		expect(JSON.stringify(logs)).not.toContain(secret);
	}
);
