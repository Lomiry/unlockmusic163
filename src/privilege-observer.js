const fs = require('fs');

const FIELDS = new Set([
	'privilege',
	'privileges',
	'cp',
	'fee',
	'st',
	'pl',
	'dl',
	'fl',
	'sp',
	'subp',
	'payed',
	'noCopyrightRcmd',
	'playable',
	'unplayableType',
	'plLevel',
	'dlLevel',
	'flLevel',
	'playMaxbr',
	'downloadMaxbr',
]);
const CONTAINERS = new Set([
	'data',
	'result',
	'results',
	'songs',
	'song',
	'album',
	'albums',
	'tracks',
	'track',
	'list',
	'items',
	'item',
	'artists',
	'artist',
	'resources',
	'resource',
]);
const SENSITIVE =
	/^(?:user|users|profile|account|creator|cookie|cookies|token|csrf|deviceId|header|headers|authorization|password|session|sessionKey)$/i;
const typeOf = (value) =>
	value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const targetPath = (apiPath) => {
	if (typeof apiPath !== 'string') return null;
	const path = apiPath.split(/[?#]/, 1)[0];
	if (path.length > 256) return null;
	return [
		'/api/album/privilege',
		'/api/album/v3/detail',
		'/api/v1/artist/top/song',
		'/api/artist/top/song',
	].includes(path) ||
		/^\/api\/(?:v[1-3]\/)?search\/[a-zA-Z0-9_/-]+$/.test(path)
		? path
		: null;
};

// JSON paths must never contain unknown keys (names, IDs or tokens). Replace
// such segments with *, skip sensitive branches, and never invoke accessors.
const summarize = (json) => {
	const fields = new Map(),
		arrays = new Map(),
		seen = new WeakSet();
	let nodesVisited = 0,
		truncated = false;
	const visit = (node, path, depth) => {
		if (nodesVisited >= 256) {
			truncated = true;
			return;
		}
		nodesVisited++;
		if (!node || typeof node !== 'object') return;
		if (seen.has(node)) {
			truncated = true;
			return;
		}
		seen.add(node);
		if (Array.isArray(node)) {
			let entry = arrays.get(path);
			if (!entry && arrays.size < 16) {
				entry = {
					path,
					minLength: node.length,
					maxLength: node.length,
					samples: 0,
				};
				arrays.set(path, entry);
			} else if (!entry) truncated = true;
			if (entry) {
				entry.minLength = Math.min(entry.minLength, node.length);
				entry.maxLength = Math.max(entry.maxLength, node.length);
				entry.samples++;
			}
		}
		if (depth >= 8) {
			truncated = true;
			return;
		}
		if (Array.isArray(node)) {
			if (node.length > 4) truncated = true;
			for (let i = 0; i < Math.min(node.length, 4); i++) {
				const descriptor = Object.getOwnPropertyDescriptor(
					node,
					String(i)
				);
				if (descriptor && 'value' in descriptor)
					visit(descriptor.value, path + '[]', depth + 1);
			}
			return;
		}
		let count = 0;
		for (const key in node) {
			if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
			if (count++ === 64) {
				truncated = true;
				break;
			}
			if (SENSITIVE.test(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(node, key);
			if (!descriptor || !('value' in descriptor)) {
				truncated = true;
				continue;
			}
			const known = FIELDS.has(key);
			const childPath =
				path + '.' + (known || CONTAINERS.has(key) ? key : '*');
			if (known) {
				const type = typeOf(descriptor.value),
					id = childPath + ':' + type;
				if (fields.size < 64 || fields.has(id))
					fields.set(id, { field: key, path: childPath, type });
				else truncated = true;
			}
			if (descriptor.value && typeof descriptor.value === 'object')
				visit(descriptor.value, childPath, depth + 1);
		}
	};
	visit(json, '$', 0);
	return {
		rootType: typeOf(json),
		fields: Array.from(fields.values()),
		arrays: Array.from(arrays.values()),
		nodesVisited,
		truncated,
	};
};

const createPrivilegeObserver = ({
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
			if (!enabled || !filePath || pending || records >= 60) return;
			const path = targetPath(apiPath);
			if (!path) return;
			const time = now();
			if (time - lastSample < 1000) return;
			lastSample = time;
			pending = true;
			defer(() => {
				try {
					const line =
						JSON.stringify({
							msg: 'NCM XEAPI privilege schema',
							apiPath: path,
							...summarize(json),
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

const schedulePrivilegeObservation = createPrivilegeObserver({
	enabled: process.env.UNM_PRIVILEGE_OBSERVER === 'true',
	filePath:
		process.env.UNM_PRIVILEGE_LOG_FILE ||
		(process.env.LOG_FILE
			? process.env.LOG_FILE + '.privilege'
			: undefined),
});
module.exports = { createPrivilegeObserver, schedulePrivilegeObservation };
