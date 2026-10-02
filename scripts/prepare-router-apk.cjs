const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sdk = process.argv[2];
if (!sdk)
	throw Error('Usage: node scripts/prepare-router-apk.cjs SDK_DIRECTORY');
const target = path.resolve(sdk, 'package/unblockneteasemusic-stage9');
if (!fs.existsSync(path.resolve(sdk, 'include/package.mk')))
	throw Error('Not an OpenWrt SDK directory');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(
	path.join(root, 'openwrt/unblockneteasemusic-stage9/Makefile'),
	path.join(target, 'Makefile')
);
fs.mkdirSync(path.join(target, 'files'), { recursive: true });
const helper = fs
	.readFileSync(
		path.join(root, 'openwrt/unblockneteasemusic-stage9/files/unm-stage9'),
		'utf8'
	)
	.replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(target, 'files/unm-stage9'), helper, {
	mode: 0o755,
});
const payload = path.join(target, 'payload');
fs.mkdirSync(payload, { recursive: true });
for (const [from, to] of Object.entries({
	'precompiled/app.js': 'app.js',
	'precompiled/app.js.LICENSE.txt': 'app.js.LICENSE.txt',
	COPYING: 'COPYING',
	'COPYING.LESSER': 'COPYING.LESSER',
	'docs/router-apk.md': 'README.md',
}))
	fs.copyFileSync(path.join(root, from), path.join(payload, to));
const sums = fs
	.readdirSync(payload)
	.filter((file) => file !== 'SHA256SUMS')
	.sort()
	.map(
		(file) =>
			crypto
				.createHash('sha256')
				.update(fs.readFileSync(path.join(payload, file)))
				.digest('hex') +
			'  ' +
			file +
			'\n'
	)
	.join('');
fs.writeFileSync(path.join(payload, 'SHA256SUMS'), sums);
console.log('Prepared APK package at ' + target);
