const { Readable, Writable } = require('stream');
const { once } = require('events');
const zlib = require('zlib');
const crypto = require('./crypto');
jest.mock('./privilege-observer', () => ({
	...jest.requireActual('./privilege-observer'),
	schedulePrivilegeObservation: jest.fn(),
}));
const {
	createPrivilegeObserver,
	schedulePrivilegeObservation,
} = require('./privilege-observer');
const { observeResponse } = require('./xeapi');
const SECRET = 'SECRET_NEVER_LOG';
const fixture = (options = {}) => {
	const jobs = [],
		writes = [];
	let time = 0;
	const observer = createPrivilegeObserver({
		enabled: true,
		filePath: '/diagnostic-only',
		now: () => time,
		defer: (job) => jobs.push(job),
		appendFile: (_, line, cb) => {
			writes.push(JSON.parse(line));
			cb(null);
		},
		...options,
	});
	return {
		observer,
		jobs,
		writes,
		advance: () => {
			time += 1000;
		},
		flush: () => {
			while (jobs.length) jobs.shift()();
		},
	};
};
const schema = () => ({
	code: 200,
	data: {
		songs: [
			{
				name: SECRET,
				id: SECRET,
				privilege: {
					cp: 1,
					fee: 8,
					st: -200,
					pl: 0,
					dl: 0,
					fl: 0,
					sp: 0,
					subp: 1,
					payed: 0,
					playable: false,
					unplayableType: SECRET,
					noCopyrightRcmd: { name: SECRET },
					plLevel: SECRET,
					dlLevel: SECRET,
					flLevel: SECRET,
					playMaxbr: 0,
					downloadMaxbr: 0,
				},
			},
			{ name: SECRET, privilege: { pl: 320000 } },
		],
	},
	users: [{ privileges: { playable: true, token: SECRET } }],
	token: { pl: SECRET },
});

test('default off neither inspects JSON nor schedules work', () => {
	const f = fixture({ enabled: false });
	f.observer(
		'/api/album/privilege',
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
});
test.each([
	'/api/album/privilege',
	'/api/album/v3/detail',
	'/api/v1/artist/top/song',
	'/api/artist/top/song',
	'/api/search/complex/get',
	'/api/v1/search/song/get',
])('targets %s', (apiPath) => {
	const f = fixture();
	f.observer(apiPath, schema());
	f.flush();
	expect(f.writes).toHaveLength(1);
});
test.each([
	'/api/song/enhance/player/url/v1',
	'/api/album/play',
	'/api/batch',
	'/api/search/SECRET%0A',
	'http://example.org/api/search/test',
])('ignores unrelated or invalid path %s', (apiPath) => {
	const f = fixture();
	f.observer(apiPath, schema());
	expect(f.jobs).toHaveLength(0);
});
test('logs allowed field paths/types and array lengths, not any field values or sensitive branches', () => {
	const f = fixture(),
		json = schema(),
		before = JSON.stringify(json);
	f.observer('/api/album/v3/detail?token=' + SECRET, json);
	expect(f.writes).toHaveLength(0);
	f.flush();
	const record = f.writes[0],
		text = JSON.stringify(record);
	expect(record.rootType).toBe('object');
	expect(record.apiPath).toBe('/api/album/v3/detail');
	expect(record.fields).toContainEqual({
		field: 'pl',
		path: '$.data.songs[].privilege.pl',
		type: 'number',
	});
	expect(record.fields).toContainEqual({
		field: 'playable',
		path: '$.data.songs[].privilege.playable',
		type: 'boolean',
	});
	expect(record.arrays).toContainEqual({
		path: '$.data.songs',
		minLength: 2,
		maxLength: 2,
		samples: 1,
	});
	expect(record.fields.filter((field) => field.field === 'pl')).toHaveLength(
		1
	);
	expect(text).not.toContain(SECRET);
	expect(text).not.toContain('users');
	expect(text).not.toContain('token');
	expect(JSON.stringify(json)).toBe(before);
});
test('unknown property keys cannot leak names or IDs through paths; accessor values are skipped', () => {
	const f = fixture(),
		json = { [SECRET]: { privileges: [{ pl: 0 }] } };
	Object.defineProperty(json, 'privilege', {
		enumerable: true,
		get() {
			throw Error(SECRET);
		},
	});
	f.observer('/api/album/privilege', json);
	f.flush();
	expect(f.writes[0].fields).toContainEqual({
		field: 'pl',
		path: '$.*.privileges[].pl',
		type: 'number',
	});
	expect(JSON.stringify(f.writes)).not.toContain(SECRET);
	expect(f.writes[0].truncated).toBe(true);
});
test.each([
	[[], 'array'],
	[null, 'null'],
	['TEXT_SECRET', 'string'],
])('root type handles %s without exposing values', (json, rootType) => {
	const f = fixture();
	f.observer('/api/album/privilege', json);
	f.flush();
	expect(f.writes[0].rootType).toBe(rootType);
	expect(JSON.stringify(f.writes)).not.toContain('TEXT_SECRET');
});
test('limits depth and cyclic references without infinite traversal', () => {
	let json = { pl: SECRET };
	for (let i = 0; i < 20; i++) json = { data: json };
	const f = fixture();
	f.observer('/api/album/privilege', json);
	f.flush();
	expect(f.writes[0].truncated).toBe(true);
	expect(f.writes[0].fields).toEqual([]);
	const cyclic = {};
	cyclic.data = cyclic;
	f.advance();
	f.observer('/api/search/get', cyclic);
	f.flush();
	expect(f.writes[1].truncated).toBe(true);
});
test('bounds wide objects, array samples, nodes, paths and serialized log size', () => {
	const json = {
		data: Array.from({ length: 100 }, () =>
			Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [
					'container' + i,
					{ privileges: [{ pl: SECRET, fee: SECRET }] },
				])
			)
		),
	};
	const f = fixture();
	f.observer('/api/search/get', json);
	f.flush();
	const r = f.writes[0];
	expect(r.nodesVisited).toBeLessThanOrEqual(256);
	expect(r.fields.length).toBeLessThanOrEqual(64);
	expect(r.arrays.length).toBeLessThanOrEqual(16);
	expect(r.truncated).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(16384);
	expect(JSON.stringify(r)).not.toContain(SECRET);
});
test('rate/total limits, no queue while writer is slow, async write errors are isolated', () => {
	let release;
	const f = fixture({
		appendFile: (_, __, cb) => {
			release = cb;
		},
	});
	f.observer('/api/search/get', schema());
	f.flush();
	for (let i = 0; i < 500; i++) {
		f.advance();
		expect(f.observer('/api/search/get', schema())).toBeUndefined();
	}
	expect(f.jobs).toHaveLength(0);
	release(Error(SECRET));
	f.advance();
	f.observer('/api/search/get', schema());
	expect(f.jobs).toHaveLength(1);
	const g = fixture();
	for (let i = 0; i < 100; i++) {
		g.observer('/api/search/get', schema());
		g.flush();
		g.observer('/api/search/get', schema());
		g.flush();
		g.advance();
	}
	expect(g.writes).toHaveLength(60);
});
test.each(['scheduler', 'writer', 'keys'])(
	'throws in %s cannot escape',
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
		const json =
			mode === 'keys'
				? new Proxy(
						{},
						{
							ownKeys() {
								throw Error(SECRET);
							},
						}
					)
				: schema();
		expect(() => {
			f.observer('/api/album/privilege', json);
			f.flush();
		}).not.toThrow();
		expect(f.writes).toHaveLength(0);
	}
);
test.each([false, true])(
	'reuses existing decoded JSON, preserves ciphertext/headers if schema hook throws (gzip=%s)',
	async (gzip) => {
		const json = schema(),
			plain = Buffer.from(JSON.stringify(json)),
			body = crypto.eapi.encrypt(gzip ? zlib.gzipSync(plain) : plain);
		const response = Readable.from([body.subarray(0, 7), body.subarray(7)]);
		response.headers = {
			'content-length': String(body.length),
			'x-encr-ssid': SECRET,
		};
		response.statusCode = 200;
		const headers = { ...response.headers },
			logs = [];
		let complete;
		const done = new Promise((resolve) => {
			complete = resolve;
		});
		schedulePrivilegeObservation.mockImplementation((apiPath, decoded) => {
			expect(apiPath).toBe('/api/album/privilege');
			expect(decoded).toEqual(json);
			complete();
			throw Error(SECRET);
		});
		observeResponse(response, '/api/album/privilege', {
			info: (fields, msg) => logs.push({ fields, msg }),
		});
		const received = [],
			sink = new Writable({
				write(chunk, _, cb) {
					received.push(Buffer.from(chunk));
					cb();
				},
			}),
			finish = once(sink, 'finish');
		response.pipe(sink);
		await Promise.all([done, finish]);
		await new Promise((resolve) => setImmediate(resolve));
		expect(Buffer.concat(received)).toEqual(body);
		expect(response.headers).toEqual(headers);
		expect(logs.map((log) => log.msg)).toEqual([
			'NCM XEAPI response',
			'NCM XEAPI decoded response',
		]);
		expect(JSON.stringify(logs)).not.toContain(SECRET);
	}
);
