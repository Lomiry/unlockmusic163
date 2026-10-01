const { createAlbumPlayObserver } = require('./album-play-observer');
const PATH = '/api/song/enhance/player/url/v1',
	SECRET = 'SECRET_NEVER_LOG';
const fixture = (options = {}) => {
	const jobs = [],
		writes = [];
	let time = 0;
	const observer = createAlbumPlayObserver({
		enabled: true,
		filePath: 'diagnostic',
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
const record = (json) => {
	const f = fixture();
	f.observer(PATH, json);
	f.flush();
	return f.writes[0];
};
test('records allowed structure and state values without changing JSON', () => {
	const input = {
		code: 200,
		data: [
			{
				url: 'https://' + SECRET + '/secret?token=' + SECRET,
				br: 320000,
				size: 999,
				type: 'mp3',
				level: 'exhigh',
				encodeType: 'mp3',
				flag: 0,
				fee: 8,
				payed: 0,
				st: -200,
				pl: 0,
				dl: 0,
				fl: 0,
				sp: 0,
				cp: 0,
				subp: 0,
				playMaxbr: 999000,
				downloadMaxbr: 999000,
				plLevel: 'none',
				dlLevel: 'none',
				flLevel: 'none',
				playable: false,
				unplayableType: 1,
				privilege: { pl: 0 },
				freeTrialInfo: { message: SECRET, code: SECRET },
				trialInfo: null,
				message: SECRET,
				id: SECRET,
				name: SECRET,
				artistName: SECRET,
			},
		],
		user: { code: 123, token: SECRET },
		header: { code: 456 },
		session: { code: 789 },
	};
	const original = JSON.stringify(input),
		result = record(input);
	expect(result.rootType).toBe('object');
	expect(result.code).toBe(200);
	expect(result.arrays).toEqual([{ path: '$.data', length: 1 }]);
	expect(result.fields).toContainEqual({
		path: '$.data[0].br',
		field: 'br',
		type: 'number',
		value: 320000,
	});
	expect(result.fields).toContainEqual({
		path: '$.data[0].size',
		field: 'size',
		type: 'number',
	});
	expect(result.fields).toContainEqual({
		path: '$.data[0].freeTrialInfo',
		field: 'freeTrialInfo',
		type: 'object',
	});
	expect(result.urlState).toEqual({ present: false });
	expect(result.urlStates[0].scheme).toBe('https');
	expect(result.urlStates[0].nonEmpty).toBe(true);
	expect(JSON.stringify(result)).not.toContain(SECRET);
	expect(result.fields.some((f) => [123, 456, 789].includes(f.value))).toBe(
		false
	);
	expect(JSON.stringify(input)).toBe(original);
	expect(result.truncated).toBe(false);
});
test.each([
	null,
	'',
	'https://SECRET',
	'http://SECRET',
	'file://SECRET',
	123,
	{},
	[],
])('URL state %j discloses no URL value', (url) => {
	const result = record({ url });
	expect(result.urlState.present).toBe(true);
	expect(result.urlState.isNull).toBe(url === null);
	if (typeof url === 'string') {
		expect(result.urlState.length).toBe(url.length);
		expect(result.urlState.nonEmpty).toBe(url.length > 0);
	}
	expect(JSON.stringify(result)).not.toContain('SECRET');
});
test('urls array tracks individual index states and lengths without IDs', () => {
	const result = record({
		data: {
			urls: [
				null,
				'https://' + SECRET,
				'',
				{ url: 'http://' + SECRET, id: SECRET },
			],
		},
	});
	expect(result.urlStates.map((s) => s.path)).toEqual([
		'$.data.urls[0]',
		'$.data.urls[1]',
		'$.data.urls[2]',
		'$.data.urls[3].url',
	]);
	expect(JSON.stringify(result)).not.toContain(SECRET);
});
test.each(['type', 'level', 'encodeType', 'plLevel', 'dlLevel', 'flLevel'])(
	'unknown enum %s omitted',
	(field) => {
		const result = record({ [field]: SECRET });
		expect(result.fields[0]).not.toHaveProperty('value');
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	}
);
test.each([
	'code',
	'br',
	'flag',
	'fee',
	'payed',
	'st',
	'pl',
	'dl',
	'fl',
	'sp',
	'cp',
	'subp',
	'playMaxbr',
	'downloadMaxbr',
])('numeric %s only accepts safe integers', (field) => {
	for (const value of [
		SECRET,
		null,
		true,
		{},
		NaN,
		Infinity,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		const result = record({ [field]: value });
		expect(result.fields[0]).not.toHaveProperty('value');
		expect(JSON.stringify(result)).not.toContain(SECRET);
	}
});
test('known enums emitted with original case strictly enforced', () => {
	const result = record({
		type: 'flac',
		level: 'lossless',
		encodeType: 'aac',
		plLevel: 'none',
		dlLevel: 'hires',
		flLevel: 'standard',
	});
	expect(result.fields.every((f) => f.value)).toBe(true);
});
test.each([null, {}, [], SECRET, 1])('trial metadata only type %j', (trial) => {
	const result = record({ freeTrialInfo: trial, trialInfo: trial });
	expect(result.fields.every((f) => !('value' in f))).toBe(true);
	expect(result.urlStates).toEqual([]);
	expect(JSON.stringify(result)).not.toContain(SECRET);
});
test('unknown container keys are anonymized; secret scalar keys not logged', () => {
	const result = record({
		[SECRET]: { data: { url: 'https://' + SECRET, code: 200 } },
		[SECRET + 'name']: SECRET,
	});
	expect(result.fields.some((f) => f.path === '$.*.data.code')).toBe(true);
	expect(JSON.stringify(result)).not.toContain(SECRET);
});
test('accessors never called including root URL and code', () => {
	const input = {};
	for (const key of ['url', 'code', 'data'])
		Object.defineProperty(input, key, {
			enumerable: true,
			get() {
				throw Error(SECRET);
			},
		});
	const result = record(input);
	expect(result.code).toBe(null);
	expect(result.urlState).toEqual({ present: true, type: 'accessor' });
	expect(result.truncated).toBe(true);
});
test('caps arrays and reports original length', () => {
	const result = record({
		data: Array.from({ length: 50 }, () => ({ url: null, code: 200 })),
	});
	expect(result.arrays[0].length).toBe(50);
	expect(result.urlStates).toHaveLength(16);
	expect(result.truncated).toBe(true);
});
test('caps depth, nodes and output fields', () => {
	let deep = { url: null };
	for (let i = 0; i < 20; i++) deep = { data: deep };
	expect(record(deep).truncated).toBe(true);
	const result = record({
		data: Array.from({ length: 16 }, () => ({
			data: Array.from({ length: 16 }, () => ({
				code: 200,
				url: null,
				br: 1,
			})),
		})),
	});
	expect(result.nodesVisited).toBeLessThanOrEqual(256);
	expect(result.fields.length).toBeLessThanOrEqual(96);
	expect(result.urlStates.length).toBeLessThanOrEqual(32);
	expect(result.arrays.length).toBeLessThanOrEqual(32);
	expect(result.truncated).toBe(true);
});
test('cycles, large key sets and malformed roots handled without dumping', () => {
	const cyclic = {};
	cyclic.data = cyclic;
	expect(record(cyclic).truncated).toBe(true);
	expect(
		record(
			Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => ['secret' + i, SECRET])
			)
		).truncated
	).toBe(true);
	expect(record(null).rootType).toBe('null');
	expect(record([]).rootType).toBe('array');
});
test('disabled, missing path or nonexact API has no work', () => {
	for (const options of [{ enabled: false }, { filePath: undefined }]) {
		const f = fixture(options);
		f.observer(PATH, {});
		expect(f.jobs).toHaveLength(0);
	}
	const f = fixture();
	for (const path of [
		'/api/album/privilege',
		PATH + '?token=SECRET',
		'/api/search/complex/page/v3',
		null,
	])
		f.observer(path, {});
	expect(f.jobs).toHaveLength(0);
	const defer = jest.fn();
	createAlbumPlayObserver({ filePath: 'x', defer })(PATH, {});
	expect(defer).not.toHaveBeenCalled();
});
test('asynchronous per-response line, rate cap and pending drop', () => {
	const f = fixture();
	f.observer(PATH, { code: 200 });
	f.advance();
	f.observer(PATH, { code: 403 });
	expect(f.writes).toHaveLength(0);
	expect(f.jobs).toHaveLength(1);
	f.flush();
	f.observer(PATH, { code: 403 });
	f.flush();
	f.observer(PATH, { code: 500 });
	expect(f.jobs).toHaveLength(0);
	expect(f.writes.map((x) => x.code)).toEqual([200, 403]);
});
test('sixty records maximum and no aggregation', () => {
	const f = fixture();
	for (let i = 0; i < 80; i++) {
		f.observer(PATH, { code: 200 + i });
		f.flush();
		f.advance();
	}
	expect(f.writes).toHaveLength(60);
	expect(f.writes[59].code).toBe(259);
});
test.each(['defer', 'now', 'appendFile'])(
	'failure in %s fully isolated',
	(method) => {
		const f = fixture({
			[method]: () => {
				throw Error(SECRET);
			},
		});
		expect(() => {
			f.observer(PATH, {});
			f.flush();
		}).not.toThrow();
	}
);
test('async write failure clears pending; slow writer does not queue', () => {
	let cb;
	const f = fixture({
		appendFile: (_, __, callback) => {
			cb = callback;
		},
	});
	f.observer(PATH, {});
	f.flush();
	f.advance();
	f.observer(PATH, {});
	expect(f.jobs).toHaveLength(0);
	cb(Error(SECRET));
	f.observer(PATH, {});
	expect(f.jobs).toHaveLength(1);
});
test('hostile JSON object exceptions isolated without log', () => {
	const f = fixture();
	f.observer(
		PATH,
		new Proxy(
			{},
			{
				ownKeys() {
					throw Error(SECRET);
				},
			}
		)
	);
	expect(() => f.flush()).not.toThrow();
	expect(f.writes).toHaveLength(0);
});
test('scalar urls is represented only by safe URL state', () => {
	const result = record({ urls: 'https://' + SECRET });
	expect(result.urlStates[0]).toEqual({
		path: '$.urls',
		present: true,
		type: 'string',
		isNull: false,
		nonEmpty: true,
		length: ('https://' + SECRET).length,
		scheme: 'https',
	});
	expect(JSON.stringify(result)).not.toContain(SECRET);
});
test('trial scalar and top-level metadata normalize to other', () => {
	const result = record({ trialInfo: SECRET });
	expect(result.fields[0].type).toBe('other');
	expect(result.topLevelFields[0].type).toBe('other');
});
