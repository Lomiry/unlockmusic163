const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unm-router-package-'));
const name = 'unm-stage9-router';
const directory = path.join(temporary, name);
const files = {
	'app.js': 'precompiled/app.js',
	'app.js.LICENSE.txt': 'precompiled/app.js.LICENSE.txt',
	'deploy-stage9.sh': 'scripts/deploy-stage9.sh',
	'enable-stage9.sh': 'scripts/enable-stage9.sh',
	'disable-stage9.sh': 'scripts/disable-stage9.sh',
	'rollback-stage8.sh': 'scripts/rollback-stage8.sh',
	'upgrade-stage9-performance.sh': 'scripts/upgrade-stage9-performance.sh',
	'rollback-stage9-performance.sh': 'scripts/rollback-stage9-performance.sh',
	'performance-stage9.md': 'docs/performance-stage9.md',
	'stage9-deployment.md': 'docs/android-9.6.05-stage9.md',
	COPYING: 'COPYING',
	'COPYING.LESSER': 'COPYING.LESSER',
};
const digest = (buffer) =>
	crypto.createHash('sha256').update(buffer).digest('hex');
try {
	fs.mkdirSync(directory);
	for (const [destination, source] of Object.entries(files)) {
		let data = fs.readFileSync(path.join(root, source));
		if (destination.endsWith('.sh')) {
			data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
		}
		fs.writeFileSync(path.join(directory, destination), data);
	}
	const coreHash = digest(fs.readFileSync(path.join(directory, 'app.js')));
	fs.writeFileSync(
		path.join(directory, 'README.md'),
		[
			'# UNM Stage 9 路由器核心更新包',
			'',
			'适用于已有 Node.js、UNM 服务配置与证书的 OpenWrt / ImmortalWrt。',
			'先运行 sha256sum -c SHA256SUMS，再阅读 stage9-deployment.md。',
			'将 app.js 上传为 /tmp/app.js.stage9，将需要的 .sh 脚本上传到 /tmp。',
			'指定 Stage 8 版本可执行 sh /tmp/deploy-stage9.sh，再执行 sh /tmp/enable-stage9.sh。',
			'部署脚本会核对旧版本与配置。原 Stage 9 升级与回退请看 performance-stage9.md。',
			'核心 SHA256：' + coreHash,
			'源码与许可：https://github.com/Lomiry/unlockmusic163；见 COPYING、COPYING.LESSER。',
			'',
		].join('\n')
	);
	fs.writeFileSync(
		path.join(directory, 'SHA256SUMS'),
		fs
			.readdirSync(directory)
			.sort()
			.map(
				(file) =>
					digest(fs.readFileSync(path.join(directory, file))) +
					'  ' +
					file +
					'\n'
			)
			.join('')
	);
	fs.mkdirSync(output, { recursive: true });
	const archive = path.join(output, name + '.tar.gz');
	execFileSync('tar', ['-czf', archive, '-C', temporary, name], {
		windowsHide: true,
	});
	const checksum = digest(fs.readFileSync(archive));
	fs.writeFileSync(
		path.join(output, 'SHA256SUMS'),
		checksum + '  ' + path.basename(archive) + '\n'
	);
	console.log('Router package: ' + archive);
	console.log('Core SHA256: ' + coreHash);
} finally {
	const resolved = fs.realpathSync(temporary);
	if (
		path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
		!path.basename(resolved).startsWith('unm-router-package-')
	) {
		throw new Error('Unexpected temporary package directory');
	}
	fs.rmSync(resolved, { recursive: true, force: true });
}
