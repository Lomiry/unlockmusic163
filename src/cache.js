const { EventEmitter } = require('events');
const { logScope } = require('./logger');

const logger = logScope('cache');

const CacheStorageEvents = {
	CLEANUP: 'cs@cleanup',
};

/**
 * @typedef {{data: any, expireAt: number | Date}} CacheData
 */

/**
 * A cache storage for storing any type of data.
 */
class CacheStorage extends EventEmitter {
	/**
	 * @type {string}
	 */
	id = 'Default Cache Storage';

	/**
	 * @type {Map<any, CacheData>}
	 * @readonly
	 */
	cacheMap = new Map();

	pendingMap = new Map();
	nextCleanupAt = 0;

	aliveDuration = 30 * 60 * 1000; // will expire after 30 minutes.

	/**
	 * Construct a cache storage.
	 *
	 * @param {string?} id The ID of this cache storage.
	 */
	constructor(id) {
		super();

		// Set the ID of this cache storage.
		if (id) this.id = id;

		// Register the CLEANUP event. It will clean up
		// the expired cache when emitting "CLEANUP" event.
		this.on(CacheStorageEvents.CLEANUP, () => this.removeExpiredCache());
	}

	/**
	 * Get the absolute UNIX timestamp the cache will be ended.
	 * @return {number}
	 * @constructor
	 */
	get WillExpireAt() {
		return Date.now() + this.aliveDuration;
	}

	/**
	 * Get the context for logger().
	 *
	 * @param {Record<string, string>?} customContext The additional context.
	 * @return {Record<string, string>}
	 * @private
	 */
	getLoggerContext(customContext = {}) {
		return {
			...customContext,
			cacheStorageId: this.id,
		};
	}

	/**
	 * Remove the expired cache.
	 */
	removeExpiredCache() {
		logger.debug(
			this.getLoggerContext(),
			'Cleaning up the expired caches...'
		);
		const now = Date.now();
		this.nextCleanupAt = now + 60 * 1000;
		this.cacheMap.forEach((cachedData, key) => {
			if (cachedData.expireAt <= now) this.cacheMap.delete(key);
		});
	}

	/**
	 * Cache the response.
	 *
	 * @template T
	 * @param {any} key the unique key of action to be cached.
	 * @param {() => Promise<T>} action the action to do and be cached.
	 * @param {number=} expireAt customize the expireAt of this key.
	 * @return {Promise<T>}
	 */
	async cache(key, action, expireAt) {
		// Disable the cache when the NO_CACHE = true.
		if (process.env.NO_CACHE === 'true') {
			return action();
		}

		const now = Date.now();
		// Sweep at most once per minute; each lookup still validates its own expiry.
		if (now >= this.nextCleanupAt) {
			this.nextCleanupAt = now + 60 * 1000;
			this.emit(CacheStorageEvents.CLEANUP);
		}
		const cachedData = this.cacheMap.get(key);
		if (cachedData && cachedData.expireAt > now) {
			if (logger.isLevelEnabled('debug')) {
				const logKey = typeof key === 'object' ? 'Something' : key;
				logger.debug(
					this.getLoggerContext({ logKey }),
					`${logKey} hit!`
				);
			}
			return cachedData.data;
		}
		if (cachedData) this.cacheMap.delete(key);
		// Concurrent misses for the same key share one provider request.
		if (this.pendingMap.has(key)) return this.pendingMap.get(key);
		if (logger.isLevelEnabled('debug')) {
			const logKey = typeof key === 'object' ? 'Something' : key;
			logger.debug(
				this.getLoggerContext({ logKey }),
				`${logKey} did not hit. Storing the execution result...`
			);
		}
		const pending = Promise.resolve()
			.then(action)
			.then((data) => {
				this.cacheMap.set(key, {
					data,
					expireAt: expireAt || this.WillExpireAt,
				});
				return data;
			});
		this.pendingMap.set(key, pending);
		try {
			return await pending;
		} finally {
			this.pendingMap.delete(key);
		}
	}
}

/**
 * The group which aimed to manage all CacheStorage and
 * call the common method such as `removeExpiredCache()`.
 */
class CacheStorageGroup {
	/**
	 * @type {CacheStorageGroup | undefined}
	 */
	static instance = undefined;

	/** @type {Set<CacheStorage>} */
	cacheStorages = new Set();

	/** @private */
	constructor() {}

	/**
	 * @return {CacheStorageGroup}
	 */
	static getInstance() {
		if (!CacheStorageGroup.instance)
			CacheStorageGroup.instance = new CacheStorageGroup();

		return CacheStorageGroup.instance;
	}

	cleanup() {
		this.cacheStorages.forEach((storage) => storage.removeExpiredCache());
	}
}

/**
 * The CacheStorageGroup instance that is used internally.
 *
 * Don't export it!
 *
 * @type {CacheStorageGroup}
 */
const csgInstance = CacheStorageGroup.getInstance();

/**
 * Get the managed CacheStorage.
 *
 * “Managed” means that this CacheStorage has been
 * added to CacheStorageGroup.
 *
 * @param {string} id
 * @return {CacheStorage}
 */
function getManagedCacheStorage(id) {
	const cs = new CacheStorage(id);
	csgInstance.cacheStorages.add(cs);
	return cs;
}

module.exports = {
	CacheStorage,
	CacheStorageEvents,
	CacheStorageGroup,
	getManagedCacheStorage,
};
