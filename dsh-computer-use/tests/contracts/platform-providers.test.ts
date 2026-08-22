import { test } from 'node:test'
import assert from 'node:assert/strict'

// These tests run on ANY platform (including Windows) because the providers
// load their native module lazily: constructing them and reading capabilities
// never touches the OS. This is the local safety net for macOS/Linux code
// that cannot be executed on a Windows workstation; the real native surfaces
// are verified by the GitHub Actions macos/ubuntu jobs instead.

import { detectLinux } from '../../src/providers/linux/detection.ts'
import { MacosProvider } from '../../src/providers/macos/provider.ts'
import { X11Provider } from '../../src/providers/linux/x11/provider.ts'
import { WaylandProvider } from '../../src/providers/linux/wayland/provider.ts'
import { createLinuxProvider } from '../../src/providers/linux/provider.ts'
import { createProvider } from '../../src/providers/index.ts'
import { resolveKeyCode } from '../../src/providers/macos/keymap.ts'
import { META_KEY_TOKENS } from '../../src/core/types.ts'
import { ComputerUseError } from '../../src/core/errors.ts'

const cleanEnv = (): void => {
  for (const key of ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS']) {
    delete process.env[key]
  }
}

const withEnv = (overrides: Record<string, string>, fn: () => unknown): unknown => {
  const saved: Record<string, string | undefined> = {}
  cleanEnv()
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key]
    process.env[key] = overrides[key]
  }
  try {
    return fn()
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]!
    }
  }
}

// ---------------------------------------------------------------------------
// Linux session detection (environment only; no native dependency)
// ---------------------------------------------------------------------------

test('detectLinux returns wayland for XDG_SESSION_TYPE=wayland', () => {
  const r = withEnv({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }, () => detectLinux())
  assert.equal(r.backend, 'wayland')
  assert.equal(r.waylandDisplay, 'wayland-0')
})

test('detectLinux returns wayland when only WAYLAND_DISPLAY is set', () => {
  const r = withEnv({ WAYLAND_DISPLAY: 'wayland-1' }, () => detectLinux())
  assert.equal(r.backend, 'wayland')
})

test('detectLinux returns x11 for a plain DISPLAY session', () => {
  const r = withEnv({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, () => detectLinux())
  assert.equal(r.backend, 'x11')
  assert.equal(r.display, ':0')
})

test('detectLinux falls back to x11 when only DISPLAY is set', () => {
  const r = withEnv({ DISPLAY: ':0' }, () => detectLinux())
  assert.equal(r.backend, 'x11')
})

test('detectLinux returns none without a usable display', () => {
  const r = withEnv({}, () => detectLinux())
  assert.equal(r.backend, 'none')
})

// ---------------------------------------------------------------------------
// Per-platform capability reports (pure, runnable everywhere)
// ---------------------------------------------------------------------------

test('MacosProvider advertises permission-gated capture and no overlay/semantic click', () => {
  const caps = new MacosProvider().capabilities()
  assert.equal(caps.windowEnumeration, true)
  assert.equal(caps.windowCapture, 'user-selected')
  assert.equal(caps.foregroundInput, true)
  assert.equal(caps.clipboard, true)
  assert.equal(caps.semanticClick, false)
  assert.equal(caps.overlay, false)
  assert.deepEqual(Object.keys(caps).sort(), [
    'accessibilityTree', 'backgroundInput', 'clipboard', 'clipboardRestore',
    'foregroundInput', 'launchApp', 'overlay', 'semanticClick',
    'windowCapture', 'windowEnumeration',
  ].sort())
})

test('X11Provider advertises implemented subset (AT-SPI/clipboard stubbed off)', () => {
  const caps = new X11Provider().capabilities()
  assert.equal(caps.windowEnumeration, true)
  assert.equal(caps.windowCapture, true)
  assert.equal(caps.foregroundInput, true)
  assert.equal(caps.accessibilityTree, false)
  assert.equal(caps.clipboard, false)
  assert.equal(caps.clipboardRestore, false)
  assert.equal(caps.overlay, false)
  assert.equal(caps.launchApp, true)
})

test('WaylandProvider advertises the restricted-compatibility mode', () => {
  const caps = new WaylandProvider().capabilities()
  assert.equal(caps.windowEnumeration, false)
  assert.equal(caps.windowCapture, false)
  assert.equal(caps.foregroundInput, false)
  assert.equal(caps.clipboard, 'limited')
  assert.equal(caps.clipboardRestore, false)
  assert.equal(caps.overlay, false)
  assert.equal(caps.launchApp, true)
})

test('createLinuxProvider selects the backend from the active session', () => {
  const waylandCaps = withEnv(
    { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' },
    () => createLinuxProvider().capabilities(),
  )
  assert.equal(waylandCaps.launchApp, true)
  assert.equal(waylandCaps.windowEnumeration, false)

  const x11Caps = withEnv({ DISPLAY: ':0' }, () => createLinuxProvider().capabilities())
  assert.equal(x11Caps.windowEnumeration, true)
  assert.equal(x11Caps.windowCapture, true)
})

// ---------------------------------------------------------------------------
// macOS key mapping (pure)
// ---------------------------------------------------------------------------

test('resolveKeyCode maps named keys and ASCII to Apple virtual keycodes', () => {
  assert.equal(resolveKeyCode('return'), 36)
  assert.equal(resolveKeyCode('enter'), 36)
  assert.equal(resolveKeyCode('a'), 0)
  assert.equal(resolveKeyCode('1'), 18)
  assert.equal(resolveKeyCode('esc'), 53)
  assert.equal(resolveKeyCode('cmd'), undefined)  // 'cmd' has no code; rejected as a meta key earlier
})

// ---------------------------------------------------------------------------
// Cross-platform launch hardening (rejection happens before any spawn)
// ---------------------------------------------------------------------------

test('WaylandProvider.launchApp routes through the shared launch hardening', async () => {
  const provider = new WaylandProvider()
  const blocked = [
    'bash', '/bin/sh', 'python3', 'node',
    '/tmp/payload.sh', '/tmp/run.py', 'C:\\tmp\\payload.bat',
  ]
  for (const app of blocked) {
    await assert.rejects(
      () => provider.launchApp({ app, args: [] }),
      (e: unknown) => e instanceof ComputerUseError && e.code === 'UNSAFE_APP',
      `expected ${app} to be blocked`,
    )
  }
  // Control characters in args are rejected too (previously unchecked here).
  await assert.rejects(
    () => provider.launchApp({ app: 'firefox', args: ['--profile\u0000x'] }),
    (e: unknown) => e instanceof ComputerUseError && e.code === 'UNSAFE_APP',
  )
  // A safe but missing app reaches spawn and fails cleanly instead of being
  // filtered: proves the shared check is a pass-through for regular names.
  await assert.rejects(
    () => provider.launchApp({ app: 'dsh-cu-nonexistent-app-xyz', args: [] }),
    (e: unknown) => e instanceof ComputerUseError && e.code === 'NATIVE_LAUNCH_FAILED',
  )
})

// ---------------------------------------------------------------------------
// Meta-key alias blocking (X11 forwards the raw key string to the helper)
// ---------------------------------------------------------------------------

test('META_KEY_TOKENS covers X11 keysym and Windows spellings of Meta/Super', () => {
  for (const token of ['win', 'windows', 'meta', 'cmd', 'command', 'super', 'os',
    'super_l', 'super_r', 'meta_l', 'meta_r', 'hyper_l', 'hyper_r',
    'lwin', 'rwin', 'leftmeta', 'rightmeta']) {
    assert.equal(META_KEY_TOKENS.has(token), true, `expected ${token} to be a meta token`)
  }
  assert.equal(META_KEY_TOKENS.has('shift'), false)
  assert.equal(META_KEY_TOKENS.has('ctrl'), false)
  assert.equal(META_KEY_TOKENS.has('alt'), false)
})

test('X11Provider.pressKey rejects meta aliases and empty chords before touching the helper', async () => {
  const provider = new X11Provider()
  for (const key of ['super_l', 'super_l+d', 'meta_l', 'hyper_l+f', 'lwin', '++']) {
    await assert.rejects(
      () => provider.pressKey({ windowId: 'x11:1', key }),
      (e: unknown) => e instanceof ComputerUseError && e.code === 'FORBIDDEN_KEY',
      `expected ${key} to be forbidden`,
    )
  }
})

// ---------------------------------------------------------------------------
// Lazy platform loading (eager imports would crash on a foreign platform)
// ---------------------------------------------------------------------------

test('createProvider resolves the current platform lazily', async () => {
  const provider = await createProvider()
  const info = provider.runtimeInfo()
  assert.ok(['windows', 'macos', 'x11', 'wayland'].includes(info.provider))
  if (process.platform === 'win32') assert.equal(info.provider, 'windows')
})

// ---------------------------------------------------------------------------
// X11 helper trust boundary (rejection happens before any spawn)
// ---------------------------------------------------------------------------

test('X11 helper env override must be an absolute path', async () => {
  const saved = process.env.DSH_COMPUTER_USE_X11_HELPER
  process.env.DSH_COMPUTER_USE_X11_HELPER = 'relative/helper-binary'
  try {
    const provider = new X11Provider()
    await assert.rejects(
      () => provider.listWindows(),
      (e: unknown) => e instanceof ComputerUseError && e.code === 'NATIVE_PROVIDER_UNAVAILABLE',
    )
  } finally {
    if (saved === undefined) delete process.env.DSH_COMPUTER_USE_X11_HELPER
    else process.env.DSH_COMPUTER_USE_X11_HELPER = saved
  }
})

test('X11 provider rejects cleanly when the helper binary is missing (no engine crash)', async () => {
  // spawn() reports ENOENT asynchronously via an unhandled 'error' event and
  // the first stdin write EPIPEs on the destroyed stream; both used to take
  // the whole engine process down. Every call must now reject cleanly.
  const saved = process.env.DSH_COMPUTER_USE_X11_HELPER
  delete process.env.DSH_COMPUTER_USE_X11_HELPER
  try {
    const provider = new X11Provider()
    await assert.rejects(
      () => provider.listWindows(),
      (e: unknown) => e instanceof ComputerUseError,
    )
    // Cleanup resets the provider: a follow-up call rejects again, it does
    // not wedge on the dead child handle.
    await assert.rejects(
      () => provider.getWindow('x11:1'),
      (e: unknown) => e instanceof ComputerUseError,
    )
    await provider.dispose()
  } finally {
    if (saved !== undefined) process.env.DSH_COMPUTER_USE_X11_HELPER = saved
  }
})