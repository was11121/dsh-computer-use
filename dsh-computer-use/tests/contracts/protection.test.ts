import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brandProtected } from '../../src/core/protection.ts'

const win = (title: string, className: string, processPath: string) => ({ title, className, processPath })

test('brandProtected matches DSH process-path segments', () => {
  assert.equal(brandProtected(win('Chat', 'Chrome_WidgetWin_1', 'C:\\Program Files\\DSH\\dsh.exe')), true)
  assert.equal(brandProtected(win('Chat', 'Chrome_WidgetWin_1', '/opt/deepseek/deepseek')), true)
  assert.equal(brandProtected(win('Chat', 'Chrome_WidgetWin_1', 'C:\\tools\\harness\\harness.exe')), true)
})

test('brandProtected matches DSH brand in title', () => {
  assert.equal(brandProtected(win('DeepSeek Chat', 'Chrome_WidgetWin_1', 'C:\\app\\chrome.exe')), true)
  assert.equal(brandProtected(win('DSH Harness', 'Chrome_WidgetWin_1', 'C:\\app\\chrome.exe')), true)
})

test('brandProtected matches DSH words in titles (engine console titles)', () => {
  // A console hosting the engine is typically titled with the command line,
  // not a DSH-branded product name.
  assert.equal(brandProtected(win('node D:\\DSH\\packages\\engine.js', 'ConsoleWindowClass', 'C:\\Program Files\\nodejs\\node.exe')), true)
  assert.equal(brandProtected(win('dsh engine console', 'Terminal', '/usr/bin/node')), true)
  assert.equal(brandProtected(win('harness output', 'Terminal', '/usr/bin/python3')), true)
})

test('brandProtected title match stays word-exact (mysandsh title not protected)', () => {
  assert.equal(brandProtected(win('mysandsh notes', 'Notepad', 'C:\\Windows\\notepad.exe')), false)
  assert.equal(brandProtected(win('budget helper - dshorts tool', 'Notepad', 'C:\\app\\app.exe')), false)
})

test('brandProtected protects segments prefixed with dsh- (baseline behavior)', () => {
  // A folder literally named 'dsh-stuff' is treated as DSH via the startsWith('dsh-') rule.
  assert.equal(brandProtected(win('Notes', 'Notepad', 'C:\\dsh-stuff\\notes.exe')), true)
})

test('brandProtected does not match a folder merely containing dsh (e.g. mysandsh)', () => {
  assert.equal(brandProtected(win('Sandbox', 'SandboxHost', 'C:\\mysandsh\\app.exe')), false)
})

test('brandProtected does not match an unrelated app', () => {
  assert.equal(brandProtected(win('Visual Studio Code', 'Chrome_WidgetWin_1', 'C:\\Program Files\\Microsoft VS Code\\Code.exe')), false)
})

test('brandProtected matches class names', () => {
  assert.equal(brandProtected(win('Random', 'dsh Window', 'C:\\app\\x.exe')), true)
  assert.equal(brandProtected(win('Random', 'deepseek tool', 'C:\\app\\x.exe')), true)
})

test('brandProtected does not match a class that merely contains dsh', () => {
  // (dsh|deepseek|harness) requires a whole-word match.
  assert.equal(brandProtected(win('Random', 'dshWidget', 'C:\\app\\x.exe')), false)
})

test('brandProtected strips executable extensions so a bare dsh.exe is protected', () => {
  // A process literally named dsh.exe / deepseek.exe outside a DSH folder must
  // still be recognized as DSH instead of becoming a control target.
  assert.equal(brandProtected(win('Console', 'ConsoleWindowClass', 'C:\\bin\\dsh.exe')), true)
  assert.equal(brandProtected(win('Console', 'ConsoleWindowClass', 'C:\\bin\\deepseek.exe')), true)
  assert.equal(brandProtected(win('Console', 'ConsoleWindowClass', '/usr/local/bin/harness.exe')), true)
  assert.equal(brandProtected(win('Console', 'ConsoleWindowClass', 'C:\\bin\\dsh.cmd')), true)
})

test('brandProtected extension stripping stays segment-exact (no substring match)', () => {
  assert.equal(brandProtected(win('Random', 'Shell', 'C:\\bin\\mydsh.exe')), false)
  assert.equal(brandProtected(win('Random', 'Shell', 'C:\\bin\\dshx.exe')), false)
})
