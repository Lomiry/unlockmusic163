const { Readable, PassThrough } = require('stream');
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');
const crypto = require('./crypto');
const { decodeResponse } = require('./xeapi');
const gzip = promisify(zlib.gzip),
	deflate = promisify(zlib.deflate),
	brotli = promisify(zlib.brotliCompress);
const PATH = '/api/album/privilege',
	LIMIT = 1024 * 1024;

// Work on an independent JSON copy. No changes are committed before encoding succeeds.
const patchJson = (json) => {
	if (
		!json ||
		json.code !== 200 ||
		!Array.isArray(json.data) ||
		json.data.length > 512
	)
		return null;
	let patchedCount = 0;
	const data = json.data.map((item) => {
		if (
			!item ||
			typeof item !== 'object' ||
			Array.isArray(item) ||
			!Number.isSafeInteger(item.st) ||
			item.st >= 0 ||
			!['pl', 'dl', 'sp', 'cp', 'subp'].every((key) => item[key] === 0)
		)
			return item;
		const copy = {
			...item,
			st: 0,
			cp: 1,
			sp: 7,
			subp: 1,
			pl:
				Number.isSafeInteger(item.playMaxbr) && item.playMaxbr > 0
					? item.playMaxbr
					: 320000,
			dl:
				Number.isSafeInteger(item.downloadMaxbr) &&
				item.downloadMaxbr > 0
					? item.downloadMaxbr
					: 320000,
		};
		if (item.plLevel === 'none') copy.plLevel = 'exhigh';
		if (item.dlLevel === 'none') copy.dlLevel = 'exhigh';
		patchedCount++;
		return copy;
	});
	return {
		json: { ...json, data },
		examinedCount: data.length,
		patchedCount,
	};
};
const transformBody = async (
	body,
	encoding,
	{
		decode = decodeResponse,
		encrypt = crypto.eapi.encrypt,
		compress = { gzip, deflate, br: brotli },
	} = {}
) => {
	try {
		const decoded = await decode(body, encoding);
		const result = patchJson(decoded.json);
		if (!result || !result.patchedCount)
			return {
				body,
				examinedCount: result ? result.examinedCount : 0,
				patchedCount: 0,
			};
		let output = Buffer.from(JSON.stringify(result.json));
		if (output.length > LIMIT) throw Error('limit');
		if (decoded.gzip) output = await compress.gzip(output);
		output = encrypt(output);
		if (encoding && encoding !== 'identity')
			output = await compress[encoding](output);
		if (!Buffer.isBuffer(output) || output.length > LIMIT)
			throw Error('limit');
		return {
			body: output,
			examinedCount: result.examinedCount,
			patchedCount: result.patchedCount,
		};
	} catch {
		return { body, examinedCount: 0, patchedCount: 0 };
	}
};
const createPatchLog = ({
	enabled = false,
	filePath,
	appendFile = fs.appendFile,
	defer = setImmediate,
	now = Date.now,
} = {}) => {
	let pending = false,
		last = -Infinity,
		count = 0;
	return (examinedCount, patchedCount) => {
		try {
			if (
				!enabled ||
				!filePath ||
				pending ||
				count >= 60 ||
				now() - last < 1000
			)
				return;
			last = now();
			pending = true;
			defer(() => {
				try {
					count++;
					appendFile(
						filePath,
						JSON.stringify({
							apiPath: PATH,
							examinedCount,
							patchedCount,
						}) + '\n',
						() => {
							pending = false;
						}
					);
				} catch {
					pending = false;
				}
			});
		} catch {
			pending = false;
		}
	};
};
const log = createPatchLog({
	enabled: process.env.UNM_XEAPI_PRIVILEGE_PATCH === 'true',
	filePath:
		process.env.UNM_XEAPI_PRIVILEGE_PATCH_LOG_FILE ||
		(process.env.LOG_FILE
			? process.env.LOG_FILE + '.privilege-patch'
			: undefined),
});

const createResponsePatch = ({
	enabled = false,
	apiPath = PATH,
	onFallback = () => {},
	onResult = () => {},
	transform = transformBody,
	diagnostic = log,
	timeoutMs = 2000,
	maxBytes = LIMIT,
	maxConcurrent = 8,
} = {}) => {
	let active = 0;
	return (ctx) => {
		const source = ctx.proxyRes;
		if (
			!enabled ||
			!ctx.xeapi ||
			ctx.xeapi.apiPath !== apiPath ||
			active >= maxConcurrent ||
			source.statusCode !== 200 ||
			!source.readable ||
			source.readableEnded ||
			source.destroyed
		)
			return;
		// Skip signatures/validators and partial responses rather than invalidate them.
		if (
			[
				'etag',
				'content-md5',
				'digest',
				'content-digest',
				'repr-digest',
				'content-range',
				'trailer',
			].some((key) => key in source.headers)
		)
			return;
		const encoding = source.headers['content-encoding'];
		if (
			encoding &&
			!['identity', 'gzip', 'deflate', 'br'].includes(encoding)
		)
			return;
		if (Number(source.headers['content-length']) > maxBytes) return;
		active++;
		return new Promise((resolve) => {
			let chunks = [],
				bytes = 0,
				finished = false,
				ended = false;
			const metadata = (replay) => {
				replay.statusCode = source.statusCode;
				replay.headers = source.headers;
				replay.socket = source.socket;
				return replay;
			};
			const clean = () => {
				clearTimeout(timer);
				source.removeListener('data', onData);
				source.removeListener('end', onEnd);
				source.removeListener('error', onError);
				source.removeListener('aborted', onError);
				source.removeListener('close', onClose);
			};
			const original = () => {
				if (finished) return;
				finished = true;
				clean();
				source.pause();
				const prefix = Buffer.concat(chunks, bytes);
				chunks = [];
				if (ended) ctx.proxyRes = metadata(Readable.from([prefix]));
				else {
					const replay = metadata(new PassThrough());
					// Retain prefix and backpressure before downstream attaches.
					replay.write(prefix);
					source.on('error', () => replay.destroy());
					source.pipe(replay);
					if (source.destroyed) replay.end();
					ctx.proxyRes = replay;
				}
				active--;
				resolve();
				try {
					onFallback();
				} catch {}
			};
			const onData = (chunk) => {
				chunks.push(chunk);
				bytes += chunk.length;
				if (bytes > maxBytes) original();
			};
			const onError = () => original();
			const onClose = () => {
				if (!ended) original();
			};
			const onEnd = async () => {
				ended = true;
				const body = Buffer.concat(chunks, bytes);
				try {
					const result = await transform(body, encoding);
					if (finished) return;
					if (!result || !Buffer.isBuffer(result.body))
						return original();
					const replay = metadata(Readable.from([result.body]));
					if (result.patchedCount > 0) {
						replay.headers = { ...source.headers };
						if ('content-length' in replay.headers)
							replay.headers['content-length'] = String(
								result.body.length
							);
					}
					finished = true;
					clean();
					chunks = [];
					ctx.proxyRes = replay;
					active--;
					resolve();
					try {
						diagnostic(result.examinedCount, result.patchedCount);
						onResult(result);
					} catch {
						/* Never affect forwarding. */
					}
				} catch {
					original();
				}
			};
			const timer = setTimeout(original, timeoutMs);
			source.on('data', onData);
			source.once('end', onEnd);
			source.once('error', onError);
			source.once('aborted', onError);
			source.once('close', onClose);
		});
	};
};
const preparePrivilegePatch = createResponsePatch({
	enabled: process.env.UNM_XEAPI_PRIVILEGE_PATCH === 'true',
});
module.exports = {
	patchJson,
	transformBody,
	createPatchLog,
	createResponsePatch,
	preparePrivilegePatch,
};
