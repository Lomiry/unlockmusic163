const fs = require('fs');

// No Pino/stdout, no queue: slow or failed async writes cannot hold a request.
const createBatchObserver = ({
	enabled = false,
	filePath,
	appendFile = fs.appendFile,
	defer = setImmediate,
	now = Date.now,
} = {}) => {
	let pending = false;
	let lastSample = -Infinity;
	let records = 0;
	return (param) => {
		try {
			if (!enabled || !filePath || pending || records >= 60) return;
			const time = now();
			if (time - lastSample < 1000) return;
			pending = true;
			lastSample = time;
			defer(() => {
				try {
					const structureType =
						param === null
							? 'null'
							: Array.isArray(param)
								? 'array'
								: typeof param;
					const fields = {
						structureType,
						memberCount:
							structureType === 'array' ? param.length : 0,
					};
					if (structureType === 'object') {
						const paths = new Set();
						let count = 0;
						let truncated = false;
						let keyLimit = false;
						// Bounded own-key scan. Never read member/accessor values.
						for (const key in param) {
							if (
								!Object.prototype.hasOwnProperty.call(
									param,
									key
								)
							)
								continue;
							if (count === 64) {
								truncated = true;
								keyLimit = true;
								break;
							}
							count++;
							const end = key.search(/[?#]/);
							const path = end < 0 ? key : key.slice(0, end);
							if (
								path.length > 256 ||
								!/^\/(?:api|eapi|weapi)(?:\/[a-zA-Z0-9_-]+)+\/?$/.test(
									path
								)
							)
								continue;
							if (paths.size < 16 || paths.has(path))
								paths.add(path);
							else truncated = true;
						}
						fields.memberCount = keyLimit ? null : count;
						fields.paths = Array.from(paths);
						fields.truncated = truncated;
					}
					const line =
						JSON.stringify({
							msg: 'NCM batch members',
							...fields,
						}) + '\n';
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

const scheduleBatchObservation = createBatchObserver({
	enabled: process.env.UNM_BATCH_OBSERVER === 'true',
	filePath:
		process.env.UNM_BATCH_LOG_FILE ||
		(process.env.LOG_FILE ? process.env.LOG_FILE + '.batch' : undefined),
});

module.exports = { createBatchObserver, scheduleBatchObservation };
