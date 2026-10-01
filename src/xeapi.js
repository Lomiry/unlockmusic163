const zlib = require('zlib');
const { promisify } = require('util');
const crypto = require('./crypto');
const { scheduleAlbumPlayObservation } = require('./album-play-observer');
const { schedulePrivilegeObservation } = require('./privilege-observer');
const {
	schedulePrivilegeValueObservation,
} = require('./privilege-value-observer');

const unzip = promisify(zlib.unzip);
const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);
const MAX_BYTES = 1024 * 1024;
const MAX_CAPTURES = 8;
let captures = 0;

// Decode a diagnostic copy only. Session headers/keys are never needed here.
const decodeResponse = async (buffer, encoding) => {
	const options = { maxOutputLength: MAX_BYTES };
	if (encoding === 'gzip' || encoding === 'deflate')
		buffer = await unzip(buffer, options);
	else if (encoding === 'br')
		buffer = await brotliDecompress(buffer, options);
	else if (encoding && encoding !== 'identity') throw new Error('encoding');
	const decrypted = crypto.eapi.decrypt(buffer);
	const gzip = decrypted[0] === 0x1f && decrypted[1] === 0x8b;
	const plaintext = gzip ? await gunzip(decrypted, options) : decrypted;
	const json = JSON.parse(plaintext.toString('utf8'));
	if (!json || typeof json !== 'object' || Array.isArray(json))
		throw new Error('json');
	return {
		code: Number.isSafeInteger(json.code) ? json.code : null,
		gzip,
		json,
	};
};

// Observe the stream alongside the downstream pipe, retaining a bounded copy.
// Do not use request.read(): it consumes/decompresses the forwarded response.
const observeResponse = (response, apiPath, logger) => {
	logger.info(
		{
			apiPath,
			status: response.statusCode,
			hasEncrSsid: Object.prototype.hasOwnProperty.call(
				response.headers,
				'x-encr-ssid'
			),
			hasEncrSskey: Object.prototype.hasOwnProperty.call(
				response.headers,
				'x-encr-sskey'
			),
		},
		'NCM XEAPI response'
	);
	const skipped = (reason) =>
		logger.info({ apiPath, reason }, 'NCM XEAPI observation skipped');
	if (captures >= MAX_CAPTURES) return skipped('capture_busy');
	if (response.readableEnded || response.destroyed)
		return skipped('stream_unavailable');
	captures++;
	let capture = Buffer.allocUnsafe(MAX_BYTES);
	let bytes = 0;
	let oversized = false;
	let finished = false;
	const encoding = response.headers['content-encoding'];
	const onData = (chunk) => {
		if (oversized) return;
		if (bytes + chunk.length > MAX_BYTES) {
			oversized = true;
			capture = null;
		} else {
			chunk.copy(capture, bytes);
			bytes += chunk.length;
		}
	};
	const detach = () => {
		response.removeListener('data', onData);
		response.removeListener('end', onEnd);
		response.removeListener('error', onError);
		response.removeListener('aborted', onAborted);
		response.removeListener('close', onClose);
	};
	const finish = (reason) => {
		if (finished) return;
		finished = true;
		detach();
		if (reason || oversized || !bytes) {
			capture = null;
			captures--;
			return skipped(reason || (oversized ? 'size_limit' : 'empty_body'));
		}
		const buffer = capture.subarray(0, bytes);
		capture = null;
		decodeResponse(buffer, encoding)
			.then(({ code, gzip, json }) => {
				logger.info(
					{ apiPath, code, gzip },
					'NCM XEAPI decoded response'
				);
				try {
					schedulePrivilegeObservation(apiPath, json);
				} catch {
					// Schema diagnostics cannot alter the existing decode result.
				}
				try {
					schedulePrivilegeValueObservation(apiPath, json);
				} catch {
					// Value diagnostics are independent of schema and forwarding.
				}
				try {
					scheduleAlbumPlayObservation(apiPath, json);
				} catch {
					// Album playback diagnostics cannot affect the decode or stream.
				}
			})
			.catch(() =>
				// Never log errors: their messages can include decrypted JSON.
				logger.info(
					{ apiPath, reason: 'decode_failed' },
					'NCM XEAPI decode failed'
				)
			)
			.finally(() => captures--);
	};
	const onEnd = () => finish();
	const onError = () => finish('stream_error');
	const onAborted = () => finish('stream_aborted');
	const onClose = () => finish('stream_closed');
	response.on('data', onData);
	response.once('end', onEnd);
	response.once('error', onError);
	response.once('aborted', onAborted);
	response.once('close', onClose);
	// Adding a data listener starts flowing. Wait for server.js to attach its
	// downstream pipe so that no bytes can escape before the client is ready.
	response.pause();
};

module.exports = { observeResponse, decodeResponse };
