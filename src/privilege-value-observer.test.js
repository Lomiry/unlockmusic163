const { createPrivilegeValueObserver } = require('./privilege-value-observer');
const ALBUM = '/api/album/privilege';
const SECRET = 'SECRET_NEVER_LOG';
const fixture = (options = {}) => {
	const jobs = [],
		writes = [];
	let time = 0;
	const observer = createPrivilegeValueObserver({
		enabled: true,
		filePath: '/diagnostic-only',
		defer: (job) => jobs.push(job),
		now: () => time,
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
		flush: () => {
			while (jobs.length) jobs.shift()();
		},
		advance: () => {
			time += 1000;
		},
	};
};
const record = (json, path = ALBUM) => {
	const f = fixture();
	f.observer(path, json);
	f.flush();
	return f.writes[0];
};
test('album aggregates permissions without names, IDs or other properties', () => {
	const input = {
		data: [
			{
				id: SECRET,
				name: SECRET,
				cookie: SECRET,
				pl: 0,
				fee: 0,
				plLevel: 'none',
			},
			{ plLevel: 'none', fee: 0, pl: 0, id: 999 },
			{ pl: 320000 },
		],
	};
	const before = JSON.stringify(input);
	const result = record(input);
	expect(result.elementCount).toBe(3);
	expect(result.privilegeSignatures).toEqual([
		{ signature: { fee: 0, pl: 0, plLevel: 'none' }, count: 2 },
		{ signature: { pl: 320000 }, count: 1 },
	]);
	expect(result.truncated).toBe(false);
	expect(JSON.stringify(result)).not.toContain(SECRET);
	expect(JSON.stringify(input)).toBe(before);
});
test.each([1, 15])('observed album length %i retains exact count', (length) => {
	const result = record({ data: Array.from({ length }, () => ({ pl: 0 })) });
	expect(result.elementCount).toBe(length);
	expect(result.privilegeSignatures[0].count).toBe(length);
});
test.each(['/api/v1/artist/top/song', '/api/artist/top/song'])(
	'artist %s only reads nested privilege',
	(path) => {
		const result = record(
			{
				songs: [
					{ name: SECRET, st: 555, privilege: { st: -200, pl: 0 } },
					{ privilege: { pl: 0, st: -200 } },
				],
			},
			path
		);
		expect(result.privilegeSignatures).toEqual([
			{ signature: { st: -200, pl: 0 }, count: 2 },
		]);
	}
);
test('all fourteen allowed fields survive with safe types', () => {
	const signature = {
		fee: 8,
		payed: 0,
		st: -200,
		pl: 0,
		dl: 0,
		sp: 7,
		cp: 0,
		subp: 1,
		fl: 0,
		playMaxbr: 320000,
		downloadMaxbr: 0,
		plLevel: 'none',
		dlLevel: 'exhigh',
		flLevel: 'lossless',
	};
	expect(
		record({ data: [signature] }).privilegeSignatures[0].signature
	).toEqual(signature);
});
test('unknown strings, objects, boolean, null, nonfinite numbers are omitted', () => {
	const result = record({
		data: [
			{
				fee: SECRET,
				plLevel: SECRET,
				dlLevel: {},
				cp: null,
				payed: true,
				fl: Infinity,
				dl: NaN,
				st: 0,
			},
		],
	});
	expect(result.privilegeSignatures).toEqual([
		{ signature: { st: 0 }, count: 1 },
	]);
	expect(result.truncated).toBe(true);
	expect(JSON.stringify(result)).not.toContain(SECRET);
});
test('missing values differ from zero', () => {
	expect(
		record({ data: [{ pl: 0 }, { pl: 0, cp: 0 }] }).privilegeSignatures
	).toHaveLength(2);
});
test('no getters or sensitive branches are read', () => {
	const privilege = { st: 0 };
	Object.defineProperty(privilege, 'pl', {
		get: () => {
			throw Error(SECRET);
		},
	});
	Object.defineProperty(privilege, 'name', {
		get: () => {
			throw Error(SECRET);
		},
	});
	expect(record({ data: [privilege] }).privilegeSignatures).toEqual([
		{ signature: { st: 0 }, count: 1 },
	]);
});
test('caps distinct signatures but continues counting existing ones', () => {
	const result = record({
		data: [...Array.from({ length: 20 }, (_, pl) => ({ pl })), { pl: 0 }],
	});
	expect(result.privilegeSignatures).toHaveLength(16);
	expect(result.privilegeSignatures[0].count).toBe(2);
	expect(result.unclassifiedCount).toBe(4);
	expect(result.truncated).toBe(true);
});
test('bounded scan reports original and sampled counts', () => {
	const result = record({
		data: Array.from({ length: 600 }, () => ({ pl: 0 })),
	});
	expect(result.elementCount).toBe(600);
	expect(result.sampledElementCount).toBe(512);
	expect(result.privilegeSignatures[0].count).toBe(512);
	expect(result.truncated).toBe(true);
});
test.each([null, {}, { data: SECRET }, { data: {} }])(
	'unexpected shapes do not dump input %j',
	(json) => {
		const result = record(json);
		expect(result.privilegeSignatures).toEqual([]);
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	}
);
test('missing privilege is unclassified without root fallback', () => {
	const result = record(
		{ songs: [{ pl: 0 }, { privilege: {} }] },
		'/api/artist/top/song'
	);
	expect(result.unclassifiedCount).toBe(2);
	expect(result.privilegeSignatures).toEqual([]);
});
test('empty array is valid', () => {
	expect(record({ data: [] }).truncated).toBe(false);
});
test('default off and unset destination schedule nothing', () => {
	for (const options of [{ enabled: false }, { filePath: undefined }]) {
		const f = fixture(options);
		f.observer(ALBUM, { data: [] });
		expect(f.jobs).toHaveLength(0);
	}
	const defer = jest.fn();
	createPrivilegeValueObserver({ filePath: 'x', defer })(ALBUM, {});
	expect(defer).not.toHaveBeenCalled();
});
test('only exact primary endpoints; queries are stripped', () => {
	const f = fixture();
	for (const path of [
		'/api/search/complex/page/v3',
		'/api/album/privilege/extra',
		SECRET,
		null,
	])
		f.observer(path, {});
	expect(f.jobs).toHaveLength(0);
	f.observer(ALBUM + '?token=' + SECRET, { data: [] });
	f.flush();
	expect(f.writes[0].apiPath).toBe(ALBUM);
});
test('deferred, limited to one per second, no pending queue', () => {
	const f = fixture();
	f.observer(ALBUM, { data: [] });
	f.advance();
	f.observer(ALBUM, {});
	expect(f.jobs).toHaveLength(1);
	expect(f.writes).toHaveLength(0);
	f.flush();
	f.observer(ALBUM, { data: [] });
	f.flush();
	f.observer(ALBUM, {});
	expect(f.jobs).toHaveLength(0);
	expect(f.writes).toHaveLength(2);
});
test('maximum sixty records per process', () => {
	const f = fixture();
	for (let i = 0; i < 80; i++) {
		f.observer(ALBUM, { data: [] });
		f.flush();
		f.advance();
	}
	expect(f.writes).toHaveLength(60);
});
test('slow asynchronous writer prevents backlog', () => {
	let finish;
	const f = fixture({
		appendFile: (_, __, cb) => {
			finish = cb;
		},
	});
	f.observer(ALBUM, {});
	f.flush();
	f.advance();
	f.observer(ALBUM, {});
	expect(f.jobs).toHaveLength(0);
	finish(null);
	f.observer(ALBUM, {});
	expect(f.jobs).toHaveLength(1);
});
test.each(['defer', 'now', 'appendFile'])(
	'%s synchronous failure is isolated',
	(method) => {
		const f = fixture({
			[method]: () => {
				throw Error(SECRET);
			},
		});
		expect(() => {
			f.observer(ALBUM, {});
			f.flush();
		}).not.toThrow();
	}
);
test('asynchronous write failure permits subsequent observations', () => {
	let attempts = 0;
	const f = fixture({
		appendFile: (_, __, cb) => {
			attempts++;
			cb(Error(SECRET));
		},
	});
	for (let i = 0; i < 2; i++) {
		f.observer(ALBUM, {});
		f.flush();
		f.advance();
	}
	expect(attempts).toBe(2);
});
test('hostile descriptor failure is isolated', () => {
	const f = fixture();
	f.observer(
		ALBUM,
		new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw Error(SECRET);
				},
			}
		)
	);
	expect(() => f.flush()).not.toThrow();
	expect(f.writes).toHaveLength(0);
});
