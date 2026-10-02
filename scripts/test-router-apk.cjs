const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const bash =
	process.platform === 'win32'
		? 'C:/Program Files/Git/bin/bash.exe'
		: '/bin/bash';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unm-apk-test-'));
const shellPath = (file) =>
	process.platform === 'win32'
		? cp
				.execFileSync(bash, ['-c', 'cygpath -u "$1"', '_', file], {
					encoding: 'utf8',
				})
				.trim()
		: file;
const write = (file, data) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data, { mode: 0o755 });
};
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const source = fs
	.readFileSync(
		path.join(
			__dirname,
			'../openwrt/unblockneteasemusic-stage9/files/unm-stage9'
		),
		'utf8'
	)
	.replace(/\r\n/g, '\n');
let checks = 0;
try {
	for (const scenario of [
		'running',
		'stopped',
		'auto-update',
		'bad-payload',
		'bad-layout',
		'edited',
	]) {
		const dir = path.join(temp, scenario);
		const core = path.join(dir, 'core/app.js');
		const init = path.join(dir, 'init');
		const payload = path.join(dir, 'payload');
		const backup = path.join(dir, 'backup');
		const marker = path.join(dir, 'running');
		const originalCore = '// original core\n';
		const newCore = '// Stage 9 core\n';
		const originalInit =
			'#!/bin/sh\nstart_service() {\n procd_append_param env LOG_LEVEL=info\n procd_append_param env UNM_XEAPI_PRIVILEGE_PATCH=false\n}\ncase "$1" in\nrunning) test -f "' +
			shellPath(marker) +
			'";;\nstop) rm -f "' +
			shellPath(marker) +
			'";;\nstart) touch "' +
			shellPath(marker) +
			'";;\nesac\n';
		write(core, originalCore);
		write(
			init,
			scenario === 'bad-layout'
				? originalInit.replace('LOG_LEVEL=', 'OTHER=')
				: originalInit
		);
		write(path.join(payload, 'app.js'), newCore);
		write(
			path.join(payload, 'SHA256SUMS'),
			digest(scenario === 'bad-payload' ? 'wrong' : newCore) +
				'  app.js\n'
		);
		write(
			path.join(dir, 'bin/uci'),
			'#!/bin/sh\necho ' + (scenario === 'auto-update' ? '1' : '0') + '\n'
		);
		const helper = path.join(dir, 'helper');
		let script = source
			.replace('test "$(id -u)" -eq 0', 'true')
			.replace('test "$(id -u)" -eq 0', 'true');
		for (const [name, value] of Object.entries({
			payload,
			core,
			init,
			backup,
		}))
			script = script.replace(
				new RegExp('^' + name + '=.*$', 'm'),
				name + "='" + shellPath(value) + "'"
			);
		write(helper, script);
		if (scenario === 'running' || scenario === 'edited') write(marker, '');
		const run = (command) =>
			cp.spawnSync(
				bash,
				['--noprofile', '--norc', shellPath(helper), command],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						PATH:
							shellPath(path.join(dir, 'bin')) +
							':' +
							(process.platform === 'win32'
								? cp.execFileSync(
										bash,
										['-c', 'printf "%s" "$PATH"'],
										{ encoding: 'utf8' }
									)
								: process.env.PATH),
					},
				}
			);
		let result = run('activate');
		if (['auto-update', 'bad-payload', 'bad-layout'].includes(scenario)) {
			assert.notEqual(result.status, 0, scenario);
			assert.equal(fs.readFileSync(core, 'utf8'), originalCore);
			assert.equal(fs.existsSync(backup), false);
		} else {
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.equal(fs.readFileSync(core, 'utf8'), newCore);
			assert.equal(
				fs.readFileSync(path.join(backup, 'core.original'), 'utf8'),
				originalCore
			);
			assert.equal(
				fs.readFileSync(path.join(backup, 'init.original'), 'utf8'),
				originalInit
			);
			assert.equal(fs.existsSync(marker), scenario !== 'stopped');
			assert.equal(
				(fs.readFileSync(init, 'utf8').match(/# UNM_STAGE9_APK/g) || [])
					.length,
				1
			);
			result = run('activate');
			assert.equal(result.status, 0, result.stdout + result.stderr);
			assert.equal(
				(fs.readFileSync(init, 'utf8').match(/# UNM_STAGE9_APK/g) || [])
					.length,
				1
			);
			if (scenario === 'edited') {
				write(core, '// user edited\n');
				assert.notEqual(run('rollback').status, 0);
				assert.equal(fs.readFileSync(core, 'utf8'), '// user edited\n');
			} else {
				result = run('rollback');
				assert.equal(result.status, 0, result.stdout + result.stderr);
				assert.equal(fs.readFileSync(core, 'utf8'), originalCore);
				assert.equal(fs.readFileSync(init, 'utf8'), originalInit);
				assert.equal(fs.existsSync(marker), scenario === 'running');
			}
		}
		checks++;
	}
	console.log(
		'APK activation/rollback sandbox: ' + checks + ' scenarios passed.'
	);
} finally {
	const resolved = path.resolve(temp);
	if (
		path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
		!path.basename(resolved).startsWith('unm-apk-test-')
	)
		throw Error('Unexpected test directory');
	fs.rmSync(resolved, { recursive: true, force: true });
}
