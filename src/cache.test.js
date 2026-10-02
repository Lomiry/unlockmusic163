const {
	CacheStorage,
	CacheStorageEvents,
	CacheStorageGroup,
} = require('./cache');

describe('CacheStorage', () => {
	describe('CacheStorage#constructor', () => {
		it('constructor() without the parameter "id" should work properly', () => {
			const cs = new CacheStorage();
			expect(cs.id).toBe('Default Cache Storage');
		});

		it('constructor() with the parameter "id" should work properly', () => {
			const cs = new CacheStorage('JestTest');
			expect(cs.id).toBe('JestTest');
		});
	});

	describe('CacheStorage#removeExpiredCache', () => {
		it('removeExpiredCache() can remove the expired entries in the CacheStorage', () => {
			const cs = new CacheStorage();
			cs.cacheMap.set('JestExpireTest', {
				data: 'hi',
				expireAt: Date.now() - 100000,
			});

			cs.removeExpiredCache();
			expect(cs.cacheMap.size).toBe(0);
			expect(cs.cacheMap.get('JestExpireTest')).not.toBeDefined();
		});

		it('removeExpiredCache() will not remove the alive entries in the CacheStorage', () => {
			const cs = new CacheStorage();
			const aliveTestObject = {
				data: 'hi2',
				expireAt: Date.now() + 10e10,
			};

			cs.cacheMap.set('JestExpireTest', {
				data: 'hi',
				expireAt: Date.now() - 100000,
			});
			cs.cacheMap.set('JestAliveTest', aliveTestObject);

			cs.removeExpiredCache();
			expect(cs.cacheMap.size).toBe(1);
			expect(cs.cacheMap.get('JestExpireTest')).not.toBeDefined();
			expect(cs.cacheMap.get('JestAliveTest')).toStrictEqual(
				aliveTestObject
			);
		});

		it('removeExpiredCache() can be called with CLEANUP (cs@cleanup) event.', (done) => {
			const cs = new CacheStorage();

			cs.on(CacheStorageEvents.CLEANUP, () => {
				expect(cs.removeExpiredCache).toHaveBeenCalledTimes(1);
				done();
			});
			cs.removeExpiredCache = jest.fn();

			cs.emit(CacheStorageEvents.CLEANUP);
		});
	});

	describe('CacheStorage#cache', () => {
		it('cache() can correctly place the cache', async () => {
			const cs = new CacheStorage();
			const mockFunc = jest
				.fn()
				.mockReturnValue(Promise.resolve().then(() => '12345'));

			await cs.cache('owo', mockFunc);

			expect(mockFunc).toHaveBeenCalledTimes(1);
			expect(cs.cacheMap.size).toBe(1);
			expect(cs.cacheMap.get('owo')).toBeDefined();
			expect(cs.cacheMap.get('owo').data).toBe('12345');
		});

		it('cache() can correctly reuse the cache', async () => {
			const cs = new CacheStorage();
			const mockFunc = jest
				.fn()
				.mockReturnValue(Promise.resolve().then(() => '12345'));

			for (let i = 0; i < 5; i++) await cs.cache('owo', mockFunc);

			expect(mockFunc).toHaveBeenCalledTimes(1);
			expect(cs.cacheMap.size).toBe(1);
			expect(cs.cacheMap.get('owo')).toBeDefined();
			expect(cs.cacheMap.get('owo').data).toBe('12345');
		});

		it('cache() (once) should return the execution result', async () => {
			const cs = new CacheStorage();
			const mockFunc = () => Promise.resolve().then(() => '12345');

			expect(await cs.cache('owo', mockFunc)).toBe('12345');
		});

		it('cache() (twice) should return the execution result', async () => {
			const cs = new CacheStorage();
			const mockFunc = () => Promise.resolve().then(() => '12345');

			await cs.cache('owo', mockFunc);

			expect(await cs.cache('owo', mockFunc)).toBe('12345');
		});

		it('cache() can trigger removeExpiredCache()', (done) => {
			const cs = new CacheStorage();
			const mockFunc = jest
				.fn()
				.mockReturnValue(Promise.resolve().then(() => '12345'));

			cs.on(CacheStorageEvents.CLEANUP, () => {
				expect(cs.removeExpiredCache).toHaveBeenCalledTimes(1);
				done();
			});
			cs.removeExpiredCache = jest.fn();

			cs.cache('owo', mockFunc);
		});
	});
});

describe('CacheStorageGroup', () => {
	const instance = CacheStorageGroup.getInstance();

	beforeEach(() => {
		// Reset the cacheStorages in CacheStorageGroup for every test.
		instance.cacheStorages.clear();
	});

	describe('CacheStorageGroup#getInstance', () => {
		it('CacheStorageGroup should be singleton', () => {
			expect(CacheStorageGroup.getInstance()).toStrictEqual(instance);
		});
	});

	describe('CacheStorageGroup#cleanup', () => {
		it('CacheStorageGroup#cleanup should call the removeExpiredCache() in every storages registered', () => {
			const cs = new CacheStorage('JestCSGTest');
			cs.removeExpiredCache = jest.fn();

			instance.cacheStorages.add(cs);
			instance.cleanup();

			expect(cs.removeExpiredCache).toHaveBeenCalledTimes(1);
		});
	});
});

describe('cache hot path and concurrent requests', () => {
	const initialNoCache = process.env.NO_CACHE;
	afterEach(() => {
		jest.restoreAllMocks();
		if (initialNoCache === undefined) delete process.env.NO_CACHE;
		else process.env.NO_CACHE = initialNoCache;
	});
	test('expired hits refresh immediately even between cleanup sweeps', async () => {
		let now = 1000;
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		const cs = new CacheStorage();
		await cs.cache('key', async () => 'first', 1010);
		now = 1011;
		expect(await cs.cache('key', async () => 'fresh')).toBe('fresh');
	});
	test('hot hits do not rescan the entire cache on every request', async () => {
		let now = 1000;
		jest.spyOn(Date, 'now').mockImplementation(() => now);
		const cs = new CacheStorage();
		const cleanup = jest.spyOn(cs, 'removeExpiredCache');
		for (let index = 0; index < 20; index++)
			await cs.cache('key', async () => 'value');
		expect(cleanup).toHaveBeenCalledTimes(1);
		now += 60000;
		await cs.cache('key', async () => 'unused');
		expect(cleanup).toHaveBeenCalledTimes(2);
	});
	test('overlapping misses share a single action and preserve resolved values', async () => {
		const cs = new CacheStorage();
		let resolve;
		const action = jest.fn(
			() =>
				new Promise((done) => {
					resolve = done;
				})
		);
		const pending = Array.from({ length: 16 }, () =>
			cs.cache('song', action)
		);
		await Promise.resolve();
		expect(action).toHaveBeenCalledTimes(1);
		resolve('audio');
		expect(await Promise.all(pending)).toEqual(Array(16).fill('audio'));
		expect(await cs.cache('song', action)).toBe('audio');
		expect(cs.pendingMap.size).toBe(0);
	});
	test('a shared failed action can be retried without poisoning the cache', async () => {
		const cs = new CacheStorage();
		const action = jest.fn(() => {
			throw new Error('provider');
		});
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, () => cs.cache('song', action))
		);
		expect(results.every((result) => result.status === 'rejected')).toBe(
			true
		);
		expect(action).toHaveBeenCalledTimes(1);
		expect(cs.pendingMap.size).toBe(0);
		expect(await cs.cache('song', async () => 'retry')).toBe('retry');
	});
	test('NO_CACHE bypasses both stored data and request coalescing', async () => {
		const cs = new CacheStorage();
		await cs.cache('song', async () => 'cached');
		process.env.NO_CACHE = 'true';
		const action = jest.fn(async () => 'live');
		expect(
			await Promise.all([
				cs.cache('song', action),
				cs.cache('song', action),
			])
		).toEqual(['live', 'live']);
		expect(action).toHaveBeenCalledTimes(2);
	});
});
