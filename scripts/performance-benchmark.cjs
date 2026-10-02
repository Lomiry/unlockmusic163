// Run with: node -r ./.pnp.cjs scripts/performance-benchmark.cjs BASELINE_DIRECTORY
process.env.LOG_LEVEL = 'silent';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const baseline = process.argv[2];
if (!baseline)
	throw Error(
		'Provide a directory containing baseline cache.cjs and player.cjs.'
	);
const loadBaseline = (file, name) => {
	const filename = path.join(root, 'src', name);
	const loaded = new Module(filename, module);
	loaded.filename = filename;
	loaded.paths = module.paths;
	loaded._compile(
		fs.readFileSync(path.join(baseline, file), 'utf8'),
		filename
	);
	return loaded.exports;
};
const oldCache = loadBaseline('cache.cjs', 'cache-baseline.js').CacheStorage;
const oldPatch = loadBaseline('player.cjs', 'player-baseline.js').patchJson;
const newCache = require('../src/cache').CacheStorage;
const newPatch = require('../src/xeapi-player-url-patch').patchJson;
const median = (samples) =>
	samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
async function time(action, iterations) {
	for (let index = 0; index < 100; index++) await action();
	const samples = [];
	for (let round = 0; round < 5; round++) {
		const start = performance.now();
		for (let index = 0; index < iterations; index++) await action();
		samples.push(performance.now() - start);
	}
	return median(samples);
}
async function cacheTime(Cache, size) {
	const storage = new Cache();
	const expires = new Date(Date.now() + 600000);
	for (let index = 0; index < size; index++)
		storage.cacheMap.set(index, { data: index, expireAt: expires });
	return time(() => storage.cache(0, async () => 'miss'), 1000);
}
(async () => {
	const results = [];
	for (const size of [128, 4096]) {
		const before = await cacheTime(oldCache, size);
		const after = await cacheTime(newCache, size);
		results.push({
			scenario: '1000 cache hits; ' + size + ' entries',
			beforeMs: before,
			afterMs: after,
			speedup: before / after,
		});
	}
	for (const size of [1, 512]) {
		const json = {
			code: 200,
			data: Array.from({ length: size }, (_, id) => ({
				id,
				code: 200,
				url: 'https://original/audio',
				br: 320000,
			})),
		};
		const before = await time(() => oldPatch(json), 2000);
		const after = await time(() => newPatch(json), 2000);
		results.push({
			scenario: '2000 normal player responses; ' + size + ' items',
			beforeMs: before,
			afterMs: after,
			speedup: before / after,
		});
	}
	console.log(
		JSON.stringify(
			{ node: process.version, samples: 5, statistic: 'median', results },
			null,
			2
		)
	);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
