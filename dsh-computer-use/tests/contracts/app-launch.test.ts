import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLaunchApp } from '../../src/core/app-launch.ts'
import { ComputerUseError } from '../../src/core/errors.ts'

function blocked(input: string): void {
  assert.throws(() => checkLaunchApp(input), (e: unknown) => e instanceof ComputerUseError && e.code === 'UNSAFE_APP', `expected ${JSON.stringify(input)} to be blocked`)
}

test('launch hardening blocks Windows backslash paths (review: split("/") bypass)', () => {
  blocked('C:\\Windows\\System32\\cmd.exe')
  blocked('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  blocked('C:\\Windows\\System32\\cmd')
  blocked('C:\\Windows\\System32\\taskmgr.exe')
  blocked('\\\\server\\share\\cmd.exe')
  blocked('C:/Windows/System32/cmd.exe')
})

test('launch hardening blocks Unix shells and interpreters', () => {
  blocked('/bin/bash')
  blocked('/usr/bin/python3')
  blocked('bash')
  blocked('osascript')
  blocked('sh')
  blocked('node')
})

test('launch hardening blocks macOS app names', () => {
  blocked('Terminal')
  blocked('Terminal.app')
  blocked('iTerm')
})

test('launch hardening rejects path traversal and control characters', () => {
  blocked('/tmp/../../etc/passwd')
  blocked('a..\\b')
  blocked('evil\u0000.exe')
  blocked('evil\u001b.png')
})

test('launch hardening rejects NTFS 8.3 short names of blocked binaries', () => {
  // A short name resolves to the long blocked binary at spawn time while
  // matching no blocklist entry (audit: predictable counter bypass).
  blocked('POWER~1.EXE')
  blocked('C:\\Windows\\System32\\RUNDLL~1.EXE')
  blocked('python~1')
  blocked('node~2.exe')
})

test('launch hardening rejects bare names that start with a dash (argv wrapper options)', () => {
  blocked('-a')
  blocked('--args')
  // Paths that merely contain a dash after a separator stay launchable.
  const ok = checkLaunchApp('C:\\tools\\-reader\\app.exe')
  assert.equal(ok.app, 'C:\\tools\\-reader\\app.exe')
})

test('launch hardening rejects empty applications', () => {
  blocked('')
  blocked('   ')
})

test('launch hardening rejects control characters in arguments', () => {
  assert.throws(
    () => checkLaunchApp('calc.exe', ['--flag\u0000inject']),
    (e: unknown) => e instanceof ComputerUseError && e.code === 'UNSAFE_APP',
  )
})

test('launch hardening allows safe applications with string args', () => {
  const result = checkLaunchApp('C:\\Program Files\\Mozilla Firefox\\firefox.exe', ['--new-window', 42])
  assert.equal(result.app, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe')
  assert.deepEqual(result.args, ['--new-window', '42'])
})

test('launch hardening case-insensitive on basenames', () => {
  blocked('C:\\WINDOWS\\SYSTEM32\\CMD.EXE')
  blocked('C:\\Windows\\System32\\PowerShell.EXE')
})

test('launch hardening blocks script, shortcut and installer files by extension', () => {
  // spawn() executes .bat/.cmd via cmd.exe even with an arbitrary name, so the
  // blocked-name list alone cannot stop a renamed script.
  blocked('C:\\Users\\me\\Downloads\\payload.bat')
  blocked('C:\\Users\\me\\Downloads\\update.cmd')
  blocked('C:\\temp\\setup.ps1')
  blocked('C:\\temp\\macro.vbs')
  blocked('C:\\temp\\page.hta')
  blocked('C:\\temp\\installer.msi')
  blocked('C:\\temp\\link.lnk')
  blocked('C:\\temp\\site.url')
  blocked('C:\\temp\\tool.js')
  blocked('C:\\temp\\merge.reg')
  blocked('C:\\temp\\app.JAR')
  blocked('/tmp/install.sh')
  blocked('/tmp/run.py')
})

test('launch hardening still allows plain executables and extensionless names', () => {
  assert.equal(checkLaunchApp('calc.exe').app, 'calc.exe')
  assert.equal(checkLaunchApp('C:\\Program Files\\Microsoft VS Code\\Code.exe').app, 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
  assert.equal(checkLaunchApp('notepad').app, 'notepad')
})

test('launch hardening blocks argv-driven execution wrappers', () => {
  // A wrapper that executes a command taken from its arguments defeats the
  // shell blocklist (`env bash -c ...`), so the wrappers themselves are
  // blocked regardless of how their target is spelled.
  for (const app of [
    'env', 'env.exe', '/usr/bin/env',
    'nohup', 'setsid', 'stdbuf', 'timeout', 'watch', 'xargs', 'nice', 'flock', 'taskset',
    'sudo', 'su', 'doas', 'pkexec',
    'systemd-run', 'systemctl',
    'find', '/usr/bin/find', 'awk', 'gawk', 'sed', 'make', 'git', 'ssh', 'expect', 'tclsh',
  ]) {
    blocked(app)
  }
})

test('launch hardening blocks Windows execution vehicles', () => {
  blocked('wsl')
  blocked('wsl.exe')
  blocked('C:\\Windows\\System32\\wsl.exe')
  blocked('explorer.exe')
  blocked('C:\\Windows\\explorer.exe')
  blocked('schtasks.exe')
  blocked('forfiles.exe')
  blocked('msbuild.exe')
  blocked('installutil.exe')
  blocked('msxsl.exe')
  blocked('pcalua.exe')
})

test('launch hardening blocks runtimes that execute argv files', () => {
  blocked('java')
  blocked('javaw.exe')
  blocked('jshell')
  blocked('dotnet')
  blocked('mono')
  blocked('electron.exe')
})

test('launch hardening blocks document openers that resolve arbitrary handlers', () => {
  blocked('open')
  blocked('xdg-open')
  blocked('gio')
  blocked('gvfs-open')
})

test('launch hardening blocks versioned and suffixed interpreter stems', () => {
  blocked('python3.13')
  blocked('python3.13.exe')
  blocked('pythonw')
  blocked('pypy3')
  blocked('perl5.36.0')
  blocked('ruby3.2')
  blocked('php8.2')
  blocked('lua5.4')
  blocked('node22')
  blocked('deno1.46')
})

test('launch hardening blocks shell-executed document types by extension', () => {
  blocked('/home/me/app.desktop')
  blocked('/home/me/run.command')
  blocked('/home/me/task.terminal')
  blocked('/home/me/script.scpt')
  blocked('/home/me/rule.applescript')
  blocked('/home/me/flow.workflow')
  blocked('C:\\Users\\me\\Downloads\\app.msix')
  blocked('C:\\Users\\me\\Downloads\\pkg.appxbundle')
  blocked('C:\\Users\\me\\Downloads\\site.jnlp')
  blocked('C:\\Users\\me\\Downloads\\payload.settingcontent-ms')
  blocked('/tmp/installer.run')
})