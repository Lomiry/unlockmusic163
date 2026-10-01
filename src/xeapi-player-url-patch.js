const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const crypto = require('./crypto');
const { decodeResponse } = require('./xeapi');
const {
	createResponsePatch: createBufferedPatch,
} = require('./xeapi-privilege-patch');
const PATH = '/api/song/enhance/player/url/v1';
const LIMIT = 1024 * 1024;
const compressDefault = {
	gzip: promisify(zlib.gzip),
	deflate: promisify(zlib.deflate),
	br: promisify(zlib.brotliCompress),
};
const counts = () => ({
	examinedCount: 0,
	matchedFailureCount: 0,
	patchedCount: 0,
	matcherFailedCount: 0,
	skippedNoIdCount: 0,
});
const validId = (id) =>
	(Number.isSafeInteger(id) && id > 0) ||
	(typeof id === 'string' &&
		/^[1-9]\d*$/.test(id) &&
		Number.isSafeInteger(Number(id)));

// Capacity remains occupied until the provider settles, even after stream timeout.
// No extra provider requests accumulate behind hung calls; no queue or new cache.
const createBoundedMatcher = (matcher, maximum = 8) => {
	let active = 0;
	return async (id) => {
		if (active >= maximum) throw Error('capacity');
		active++;
		try {
			return await matcher(id);
		} finally {
			active--;
		}
	};
};
const match = createBoundedMatcher((id) => require('./provider/match')(id));
const patchJson = async (
	json,
	{ matcher = match, endpoint = global.endpoint } = {}
) => {
	const stats = counts();
	if (
		!json ||
		json.code !== 200 ||
		!Array.isArray(json.data) ||
		json.data.length > 512
	)
		return { ...stats, json };
	stats.examinedCount = json.data.length;
	const tasks = new Map();
	const data = await Promise.all(
		json.data.map(async (item) => {
			if (
				!item ||
				typeof item !== 'object' ||
				Array.isArray(item) ||
				item.code !== 404 ||
				item.url !== null ||
				item.br !== 0
			)
				return item;
			stats.matchedFailureCount++;
			if (!validId(item.id)) {
				stats.skippedNoIdCount++;
				return item;
			}
			try {
				const key = String(item.id);
				if (!tasks.has(key))
					tasks.set(
						key,
						Promise.resolve().then(() => matcher(item.id))
					);
				const song = await tasks.get(key);
				if (
					!song ||
					typeof song.url !== 'string' ||
					!/^https?:\/\//i.test(song.url)
				)
					throw Error('audio');
				// Same non-PC endpoint/package, type, MD5 and bitrate semantics as tryMatch.
				const type = song.br === 999000 ? 'flac' : 'mp3';
				const copy = {
					...item,
					url: endpoint
						? `${endpoint}/package/${crypto.base64.encode(song.url)}/${item.id}.${type}`
						: song.url,
					type,
					md5: song.md5 || crypto.md5.digest(song.url),
					br: song.br || 128000,
					size: song.size,
					code: 200,
					freeTrialInfo: null,
				};
				stats.patchedCount++;
				return copy;
			} catch {
				stats.matcherFailedCount++;
				return item;
			}
		})
	);
	return { ...stats, json: { ...json, data } };
};
const transformBody = async (
	body,
	encoding,
	{
		decode = decodeResponse,
		encrypt = crypto.eapi.encrypt,
		compress = compressDefault,
		...options
	} = {}
) => {
	let stats = counts();
	try {
		if (body.length > LIMIT) throw Error('limit');
		const decoded = await decode(body, encoding);
		const result = await patchJson(decoded.json, options);
		const { json, ...safe } = result;
		stats = safe;
		if (!stats.patchedCount) return { body, ...stats };
		let output = Buffer.from(JSON.stringify(json));
		if (output.length > LIMIT) throw Error('limit');
		if (decoded.gzip) output = await compress.gzip(output);
		output = encrypt(output);
		if (encoding && encoding !== 'identity')
			output = await compress[encoding](output);
		if (!Buffer.isBuffer(output) || output.length > LIMIT)
			throw Error('limit');
		return { body: output, ...stats };
	} catch {
		return { body, ...stats, patchedCount: 0 };
	}
};
const createPatchLog = ({
	enabled = false,
	filePath = '/var/run/unblockneteasemusic/xeapi-player-url-patch.log',
	appendFile = fs.appendFile,
	defer = setImmediate,
} = {}) => {
	let pending = 0;
	return (result = counts()) => {
		if (!enabled || pending >= 8) return;
		try {
			const safe = counts();
			for (const key of Object.keys(safe))
				if (Number.isSafeInteger(result[key]) && result[key] >= 0)
					safe[key] = result[key];
			const line = JSON.stringify({ apiPath: PATH, ...safe }) + '\n';
			pending++;
			defer(() => {
				try {
					appendFile(filePath, line, () => {
						pending--;
					});
				} catch {
					pending--;
				}
			});
		} catch {
			if (pending) pending--;
		}
	};
};
const log = createPatchLog({
	enabled: process.env.UNM_XEAPI_PLAYER_URL_PATCH === 'true',
	filePath: process.env.UNM_XEAPI_PLAYER_URL_PATCH_LOG_FILE,
});
const createResponsePatch = ({ diagnostic = log, ...options } = {}) => {
	const safeLog = (result) => {
		try {
			diagnostic(result);
		} catch {}
	};
	const buffered = createBufferedPatch({
		...options,
		apiPath: PATH,
		transform: options.transform || transformBody,
		diagnostic: () => {},
		onResult: safeLog,
		onFallback: () => safeLog(counts()),
	});
	return (ctx) => {
		const prepared = buffered(ctx);
		if (
			!prepared &&
			options.enabled &&
			ctx.xeapi &&
			ctx.xeapi.apiPath === PATH
		)
			safeLog(counts());
		return prepared;
	};
};
const preparePlayerUrlPatch = createResponsePatch({
	enabled: process.env.UNM_XEAPI_PLAYER_URL_PATCH === 'true',
});
module.exports = {
	patchJson,
	transformBody,
	createResponsePatch,
	createPatchLog,
	createBoundedMatcher,
	preparePlayerUrlPatch,
};
