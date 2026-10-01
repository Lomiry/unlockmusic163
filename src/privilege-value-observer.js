const fs = require('fs');

const FIELDS = [
	'fee',
	'payed',
	'st',
	'pl',
	'dl',
	'sp',
	'cp',
	'subp',
	'fl',
	'playMaxbr',
	'downloadMaxbr',
	'plLevel',
	'dlLevel',
	'flLevel',
];
// Unknown strings are omitted: an allowed key alone does not make its value safe.
const LEVELS = new Set([
	'none',
	'standard',
	'higher',
	'exhigh',
	'lossless',
	'hires',
	'jyeffect',
	'sky',
	'jymaster',
	'dolby',
]);
const TARGETS = new Set([
	'/api/album/privilege',
	'/api/v1/artist/top/song',
	'/api/artist/top/song',
]);
const ownValue = (object, key) => {
	if (!object || typeof object !== 'object') return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

const summarize = (apiPath, json) => {
	const album = apiPath === '/api/album/privilege';
	const elements = ownValue(json, album ? 'data' : 'songs');
	const groups = new Map();
	let truncated = false,
		unclassifiedCount = 0;
	if (!Array.isArray(elements))
		return {
			elementCount: 0,
			sampledElementCount: 0,
			unclassifiedCount: 0,
			privilegeSignatures: [],
			truncated: true,
		};
	const sampledElementCount = Math.min(elements.length, 512);
	if (elements.length > sampledElementCount) truncated = true;
	for (let i = 0; i < sampledElementCount; i++) {
		const element = ownValue(elements, String(i));
		const privilege = album ? element : ownValue(element, 'privilege');
		const signature = {};
		if (
			privilege &&
			typeof privilege === 'object' &&
			!Array.isArray(privilege)
		) {
			for (const field of FIELDS) {
				const descriptor = Object.getOwnPropertyDescriptor(
					privilege,
					field
				);
				if (!descriptor) continue;
				const value = descriptor.value;
				if (
					'value' in descriptor &&
					(field.endsWith('Level')
						? LEVELS.has(value)
						: Number.isSafeInteger(value))
				)
					signature[field] = value;
				else truncated = true;
			}
		}
		if (!Object.keys(signature).length) {
			unclassifiedCount++;
			truncated = true;
			continue;
		}
		const key = JSON.stringify(signature);
		if (groups.has(key)) groups.get(key).count++;
		else if (groups.size < 16) groups.set(key, { signature, count: 1 });
		else {
			unclassifiedCount++;
			truncated = true;
		}
	}
	return {
		elementCount: elements.length,
		sampledElementCount,
		unclassifiedCount,
		privilegeSignatures: Array.from(groups.values()),
		truncated,
	};
};

const createPrivilegeValueObserver = ({
	enabled = false,
	filePath,
	appendFile = fs.appendFile,
	defer = setImmediate,
	now = Date.now,
} = {}) => {
	let pending = false,
		lastSample = -Infinity,
		records = 0;
	return (apiPath, json) => {
		try {
			if (
				!enabled ||
				!filePath ||
				pending ||
				records >= 60 ||
				typeof apiPath !== 'string'
			)
				return;
			const path = apiPath.split(/[?#]/, 1)[0];
			if (!TARGETS.has(path)) return;
			const time = now();
			if (time - lastSample < 1000) return;
			lastSample = time;
			pending = true;
			defer(() => {
				try {
					const line =
						JSON.stringify({
							msg: 'NCM XEAPI privilege values',
							apiPath: path,
							...summarize(path, json),
						}) + '\n';
					if (Buffer.byteLength(line) > 16384) {
						pending = false;
						return;
					}
					records++;
					appendFile(filePath, line, () => {
						pending = false;
					});
				} catch {
					pending = false;
				}
			});
		} catch {
			pending = false;
		}
	};
};

const schedulePrivilegeValueObservation = createPrivilegeValueObserver({
	enabled: process.env.UNM_PRIVILEGE_VALUE_OBSERVER === 'true',
	filePath:
		process.env.UNM_PRIVILEGE_VALUE_LOG_FILE ||
		(process.env.LOG_FILE
			? process.env.LOG_FILE + '.privilege-values'
			: undefined),
});
module.exports = {
	createPrivilegeValueObserver,
	schedulePrivilegeValueObservation,
};
