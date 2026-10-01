const { createBatchObserver } = require('./batch-observer');
const crypto = require('./crypto');
jest.mock('./batch-observer', () => {
	const actual = jest.requireActual('./batch-observer');
	return { ...actual, scheduleBatchObservation: jest.fn() };
});
jest.mock('./logger', () => ({
	logScope: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('./request', () => ({
	read: (req) => Promise.resolve(req.testBody),
}));
const { scheduleBatchObservation } = require('./batch-observer');
const hook = require('./hook');
const SECRET = 'SECRET_NEVER_LOG';

const fixture = (options = {}) => {
	const jobs = [],
		writes = [];
	let time = 0;
	const appendFile = jest.fn((file, line, callback) => {
		writes.push(JSON.parse(line));
		callback(null);
	});
	const observer = createBatchObserver({
		enabled: true,
		filePath: '/diagnostic-only',
		defer: (job) => jobs.push(job),
		appendFile,
		now: () => time,
		...options,
	});
	return {
		observer,
		jobs,
		writes,
		appendFile,
		advance: () => {
			time += 1000;
		},
		flush: () => {
			while (jobs.length) jobs.shift()();
		},
	};
};

test('default off performs no enumeration, scheduling or writes', () => {
	const f = fixture({ enabled: false });
	f.observer(
		new Proxy(
			{},
			{
				ownKeys() {
					throw Error(SECRET);
				},
			}
		)
	);
	expect(f.jobs).toHaveLength(0);
	expect(f.appendFile).not.toHaveBeenCalled();
});
test('missing output path performs no work', () => {
	const f = fixture({ filePath: undefined });
	f.observer({});
	expect(f.jobs).toHaveLength(0);
});
test('enumeration and writes happen after the request and never read values', () => {
	const f = fixture();
	const param = {
		['/api/song/enhance/player/url/v1?token=' + SECRET]: SECRET,
		['/api/song/enhance/player/url/v1#csrf=' + SECRET]: SECRET,
		'/eapi/song/enhance/privilege': SECRET,
		'/weapi/song/detail': SECRET,
		cookie: SECRET,
		header: SECRET,
	};
	Object.defineProperty(param, '/api/album/play', {
		enumerable: true,
		get() {
			throw Error(SECRET);
		},
	});
	Object.freeze(param);
	f.observer(param);
	expect(f.writes).toHaveLength(0);
	f.flush();
	expect(f.writes[0]).toEqual({
		msg: 'NCM batch members',
		structureType: 'object',
		memberCount: 7,
		truncated: false,
		paths: [
			'/api/song/enhance/player/url/v1',
			'/eapi/song/enhance/privilege',
			'/weapi/song/detail',
			'/api/album/play',
		],
	});
	expect(JSON.stringify(f.writes)).not.toContain(SECRET);
});
test.each([
	[null, 'null', 0],
	[[SECRET], 'array', 1],
	[SECRET, 'string', 0],
	[true, 'boolean', 0],
])(
	'unexpected structure logs only safe metadata (%#)',
	(param, structureType, memberCount) => {
		const f = fixture();
		f.observer(param);
		f.flush();
		expect(f.writes[0]).toEqual({
			msg: 'NCM batch members',
			structureType,
			memberCount,
		});
	}
);
test('malformed keys and nested values are never dumped', () => {
	const f = fixture();
	f.observer({
		['/api/test\n' + SECRET]: SECRET,
		['/api/%3Ftoken=' + SECRET]: SECRET,
		['/api/' + 'x'.repeat(300)]: SECRET,
		nested: { '/api/song/detail': SECRET },
		params: JSON.stringify({ '/api/song/detail': SECRET }),
	});
	f.flush();
	expect(f.writes[0].paths).toEqual([]);
	expect(JSON.stringify(f.writes)).not.toContain(SECRET);
});
test('bounded key scan and path count', () => {
	const f = fixture();
	f.observer(
		Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => ['/api/test/' + i, SECRET])
		)
	);
	f.flush();
	expect(f.writes[0].paths).toHaveLength(16);
	expect(f.writes[0].memberCount).toBeNull();
	expect(f.writes[0].truncated).toBe(true);
});
test('slow writer has one in-flight record, no request wait or queue', () => {
	let release;
	const f = fixture({
		appendFile: jest.fn((_, __, cb) => {
			release = cb;
		}),
	});
	f.observer({});
	f.flush();
	for (let i = 0; i < 5000; i++) {
		f.advance();
		expect(f.observer({})).toBeUndefined();
	}
	expect(f.jobs).toHaveLength(0);
	release(new Error(SECRET));
	f.advance();
	f.observer({});
	expect(f.jobs).toHaveLength(1);
});
test('rate limits to 1/s and stops after 60 records', () => {
	const f = fixture();
	for (let i = 0; i < 100; i++) {
		f.observer({});
		f.flush();
		f.observer({});
		f.flush();
		f.advance();
	}
	expect(f.writes).toHaveLength(60);
});
test.each(['scheduler', 'keys', 'writer'])(
	'isolates throwing %s without logging the error',
	(mode) => {
		const f = fixture(
			mode === 'scheduler'
				? {
						defer: () => {
							throw Error(SECRET);
						},
					}
				: mode === 'writer'
					? {
							appendFile: () => {
								throw Error(SECRET);
							},
						}
					: {}
		);
		const param =
			mode === 'keys'
				? new Proxy(
						{},
						{
							ownKeys() {
								throw Error(SECRET);
							},
						}
					)
				: {};
		expect(() => {
			f.observer(param);
			f.flush();
		}).not.toThrow();
		expect(f.writes).toHaveLength(0);
	}
);
test('even a broken diagnostic export cannot escape into the hook catch', async () => {
	scheduleBatchObservation.mockImplementation(() => {
		throw Error(SECRET);
	});
	const param = { '/api/search/get': { ids: SECRET }, e_r: true };
	const encrypted = crypto.eapi.encryptRequest(
		'https://interface3.music.163.com/api/batch',
		param
	);
	const ctx = {
		req: {
			url: '/eapi/batch',
			method: 'POST',
			headers: { host: 'interface3.music.163.com', 'x-aeapi': 'true' },
			socket: { encrypted: true },
			testBody: encrypted.body,
		},
	};
	await hook.request.before(ctx);
	expect(ctx.netease.param).toEqual(param);
	expect(ctx.netease.e_r).toBe(true);
	expect(ctx.req.body).toBe(encrypted.body);
	expect(ctx.req.headers['x-aeapi']).toBe('false');
});
