const fs = require('fs');
const PATH = '/api/song/enhance/player/url/v1';
const FIELDS = new Set([
	'code',
	'data',
	'url',
	'urls',
	'br',
	'size',
	'type',
	'level',
	'encodeType',
	'flag',
	'freeTrialInfo',
	'trialInfo',
	'privilege',
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
	'plLevel',
	'dlLevel',
	'flLevel',
	'playable',
	'unplayableType',
	'message',
]);
const NUMBERS = new Set([
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
]);
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
const FORMATS = new Set(['mp3', 'flac', 'aac', 'm4a', 'ogg', 'wav', 'mp4']);
const ENUMS = {
	type: FORMATS,
	encodeType: FORMATS,
	level: LEVELS,
	plLevel: LEVELS,
	dlLevel: LEVELS,
	flLevel: LEVELS,
};
const SENSITIVE =
	/^(?:id|ids|songId|trackId|name|songName|artistName|artist|artists|singer|singers|user|users|userInfo|profile|account|creator|cookie|cookies|token|csrf|deviceId|header|headers|authorization|password|session|sessionKey)$/i;
const typeOf = (value) =>
	value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const urlState = (value) => ({
	present: true,
	type: typeOf(value),
	isNull: value === null,
	...(typeof value === 'string'
		? {
				nonEmpty: value.length > 0,
				length: value.length,
				scheme: /^https:\/\//i.test(value)
					? 'https'
					: /^http:\/\//i.test(value)
						? 'http'
						: 'other',
			}
		: {}),
});
const summarize = (json) => {
	const fields = [],
		arrays = [],
		urlStates = [],
		topLevelFields = [],
		seen = new WeakSet();
	let nodesVisited = 0,
		truncated = false;
	const add = (list, value, max) => {
		if (list.length < max) list.push(value);
		else truncated = true;
	};
	const visit = (node, path, depth, urlElement = false) => {
		if (nodesVisited >= 256) {
			truncated = true;
			return;
		}
		nodesVisited++;
		if (urlElement && (typeof node !== 'object' || node === null))
			add(urlStates, { path, ...urlState(node) }, 32);
		if (!node || typeof node !== 'object') return;
		if (seen.has(node)) {
			truncated = true;
			return;
		}
		seen.add(node);
		if (Array.isArray(node)) add(arrays, { path, length: node.length }, 32);
		if (depth >= 8) {
			truncated = true;
			return;
		}
		if (Array.isArray(node)) {
			if (node.length > 16) truncated = true;
			for (
				let i = 0;
				i < Math.min(node.length, 16) && nodesVisited < 256;
				i++
			) {
				const descriptor = Object.getOwnPropertyDescriptor(
					node,
					String(i)
				);
				if (descriptor && 'value' in descriptor)
					visit(
						descriptor.value,
						path + '[' + i + ']',
						depth + 1,
						urlElement
					);
				else if (descriptor) truncated = true;
			}
			if (nodesVisited >= 256) truncated = true;
			return;
		}
		let keys = 0;
		for (const key in node) {
			if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
			if (keys++ >= 64 || nodesVisited >= 256) {
				truncated = true;
				break;
			}
			if (SENSITIVE.test(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(node, key);
			if (!descriptor || !('value' in descriptor)) {
				truncated = true;
				continue;
			}
			const value = descriptor.value,
				known = FIELDS.has(key),
				childPath = path + '.' + (known ? key : '*');
			if (known) {
				const field = {
					path: childPath,
					field: key,
					type: typeOf(value),
				};
				if (NUMBERS.has(key)) {
					// Status values are restricted to safe integers.
					if (Number.isSafeInteger(value)) field.value = value;
					else truncated = true;
				}
				if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
					if (ENUMS[key].has(value)) field.value = value;
					else truncated = true;
				}
				add(fields, field, 96);
				if (
					['freeTrialInfo', 'trialInfo'].includes(key) &&
					!['null', 'object', 'array'].includes(field.type)
				)
					field.type = 'other';
				if (depth === 0)
					add(
						topLevelFields,
						{ path: childPath, type: field.type },
						32
					);
				if (key === 'url')
					add(urlStates, { path: childPath, ...urlState(value) }, 32);
				if (key === 'urls' && typeof value === 'string')
					add(urlStates, { path: childPath, ...urlState(value) }, 32);
				// Trial content and messages must never be inspected or emitted.
				if (
					['url', 'freeTrialInfo', 'trialInfo', 'message'].includes(
						key
					)
				)
					continue;
			}
			if (value && typeof value === 'object')
				visit(value, childPath, depth + 1, key === 'urls');
		}
	};
	visit(json, '$', 0);
	const rootUrl =
		json && typeof json === 'object'
			? Object.getOwnPropertyDescriptor(json, 'url')
			: undefined;
	const rootCode =
		json && typeof json === 'object'
			? Object.getOwnPropertyDescriptor(json, 'code')
			: undefined;
	return {
		rootType: typeOf(json),
		code:
			rootCode &&
			'value' in rootCode &&
			Number.isSafeInteger(rootCode.value)
				? rootCode.value
				: null,
		urlState: rootUrl
			? 'value' in rootUrl
				? urlState(rootUrl.value)
				: { present: true, type: 'accessor' }
			: { present: false },
		topLevelFields,
		fields,
		arrays,
		urlStates,
		nodesVisited,
		truncated,
	};
};

const createAlbumPlayObserver = ({
	enabled = false,
	filePath,
	appendFile = fs.appendFile,
	defer = setImmediate,
	now = Date.now,
} = {}) => {
	let pending = false,
		last = -Infinity,
		records = 0;
	return (apiPath, json) => {
		try {
			if (
				!enabled ||
				!filePath ||
				apiPath !== PATH ||
				pending ||
				records >= 60
			)
				return;
			const time = now();
			if (time - last < 1000) return;
			last = time;
			pending = true;
			defer(() => {
				try {
					const line =
						JSON.stringify({
							msg: 'NCM XEAPI album play observation',
							apiPath: PATH,
							...summarize(json),
						}) + '\n';
					if (Buffer.byteLength(line) > 32768) {
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
const scheduleAlbumPlayObservation = createAlbumPlayObserver({
	enabled: process.env.UNM_ALBUM_PLAY_OBSERVER === 'true',
	filePath:
		process.env.UNM_ALBUM_PLAY_LOG_FILE ||
		'/var/run/unblockneteasemusic/album-play-observer.log',
});
module.exports = { createAlbumPlayObserver, scheduleAlbumPlayObservation };
