/**
 * macOS provider.
 *
 * Implements `DesktopProvider` for macOS. The native surface is declared in
 * `native.d.ts` and is loaded lazily so importing this module never crashes on
 * non-darwin platforms.
 *
 * Safety contract (review fixes):
 * - Every input action activates the target app AND verifies it is the
 *   frontmost application before injecting anything; keyboard events go to the
 *   focused app, so a failed activation aborts instead of typing elsewhere.
 * - Accessibility lookups stay scoped to the target window; the owner PID of
 *   the CGWindow must match the id, and there is no whole-app fallback.
 * - System-level chords (Cmd+Tab / Cmd+Q / Cmd+Space / Ctrl+Up / ...) are
 *   rejected before they reach the native layer.
 * @module
 */

import type * as Native from 'dsh-computer-use-macos-native'
import { ComputerUseError } from '../../core/errors.ts'
import type { Capabilities } from '../../core/capability.ts'
import { checkLaunchApp } from '../../core/app-launch.ts'
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  ActionResult,
  CaptureResult,
  ClickRequest,
  DesktopProvider,
  DesktopWindow,
  DragRequest,
  LaunchRequest,
  LaunchResult,
  PressKeyRequest,
  RuntimeInfo,
  ScrollRequest,
  TypeTextRequest,
} from '../../core/types.ts'

import { resolveKeyCode } from './keymap.ts'
import { META_KEY_TOKENS } from '../../core/types.ts'
const TREE_MAX_NODES = 2000
const TREE_MAX_DEPTH = 32

function nativeUnavailable(): ComputerUseError {
  return new ComputerUseError(
    'NATIVE_PROVIDER_UNAVAILABLE',
    'The macOS native provider is not available; install dsh-computer-use-macos-native on macOS',
    'RETRY',
  )
}

function toDesktopWindow(w: Native.WindowIdentity): DesktopWindow {
  return {
    windowId: w.windowId,
    title: w.title,
    appName: w.appName,
    processId: w.processId,
    processPath: w.processPath,
    className: w.className,
    rect: { ...w.rect },
    visible: w.visible,
    minimized: w.minimized,
    onScreen: w.onScreen,
    foreground: w.foreground,
    dpi: w.dpi,
  }
}

function toAccessibilityNode(n: Native.AccessibilityNode): AccessibilityNode {
  return {
    elementId: n.elementId,
    parent: n.parent,
    role: n.role,
    name: n.name,
    automationId: n.automationId,
    rect: n.rect ? { ...n.rect } : undefined,
    enabled: n.enabled,
    visible: n.visible,
    childCount: n.childCount,
  }
}

// System-level chords that must never be sent: they switch apps, quit apps,
// open Spotlight/Mission Control, take screenshots or lock the screen.
const FORBIDDEN_MAC_CHORDS: { mods: string[]; key: string }[] = [
  { mods: ['cmd'], key: 'tab' },
  { mods: ['cmd'], key: 'q' },
  { mods: ['cmd'], key: 'space' },
  { mods: ['cmd'], key: 'h' },
  { mods: ['cmd'], key: 'm' },
  { mods: ['cmd'], key: 'option' },
  { mods: ['cmd', 'option'], key: 'esc' },
  { mods: ['cmd', 'shift'], key: '3' },
  { mods: ['cmd', 'shift'], key: '4' },
  { mods: ['cmd', 'shift'], key: '5' },
  { mods: ['cmd', 'ctrl'], key: 'q' },
  { mods: ['ctrl'], key: 'up' },
  { mods: ['ctrl'], key: 'down' },
  { mods: ['ctrl'], key: 'left' },
  { mods: ['ctrl'], key: 'right' },
  { mods: ['alt'], key: 'tab' },
  { mods: ['alt'], key: 'f4' },
  { mods: ['ctrl'], key: 'esc' },
  { mods: ['ctrl', 'shift'], key: 'esc' },
]
// Shared token set (covers X11 keysym spellings and defensive aliases too);
// a duplicated short list here would drift out of sync with the other
// providers' filters.
const META_MODIFIERS: ReadonlySet<string> = META_KEY_TOKENS
function isForbiddenMacChord(mods: string[], main: string): boolean {
  return FORBIDDEN_MAC_CHORDS.some((c) => c.key === main && c.mods.every((m) => mods.includes(m)))
}

/**
 * macOS implementation of `DesktopProvider`.
 *
 * Every operation lazily loads the native addon. On Windows/Linux this class
 * is safe to import but each method returns `NATIVE_PROVIDER_UNAVAILABLE`.
 */
export class MacosProvider implements DesktopProvider {
  private nativeModule: typeof Native | null = null

  private async native(): Promise<typeof Native> {
    if (this.nativeModule) return this.nativeModule
    try {
      this.nativeModule = await import('dsh-computer-use-macos-native')
      return this.nativeModule
    } catch {
      throw nativeUnavailable()
    }
  }

  runtimeInfo(): RuntimeInfo {
    return {
      platform: 'darwin',
      arch: process.arch,
      node: process.version,
      napi: undefined,
      provider: 'macos',
      capabilities: this.capabilities(),
    }
  }

  capabilities(): Capabilities {
    // macOS aims for the full set; Screen Recording / Accessibility are
    // required, so capture and tree are marked user-gated until granted.
    return {
      windowEnumeration: true,
      windowCapture: 'user-selected',
      accessibilityTree: true,
      foregroundInput: true,
      backgroundInput: false,
      semanticClick: false,
      clipboard: true,
      clipboardRestore: true,
      overlay: false,
      launchApp: true,
    }
  }

  async listWindows(): Promise<DesktopWindow[]> {
    const native = await this.native()
    return native.listWindows().map(toDesktopWindow)
  }

  async getWindow(id: string): Promise<DesktopWindow> {
    const native = await this.native()
    const window = native.getWindow(id)
    if (!window) throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH')
    return toDesktopWindow(window)
  }

  async captureWindow(id: string, path: string): Promise<CaptureResult> {
    const native = await this.native()
    const window = native.getWindow(id)
    if (!window) throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH')
    if (!native.captureWindow(id, path)) {
      throw new ComputerUseError('NATIVE_CAPTURE_FAILED', 'Window capture failed', 'RETRY')
    }
    return { path, rect: { ...window.rect } }
  }

  async activateWindow(id: string): Promise<void> {
    const native = await this.native()
    // activateWindow verifies frontmost application + raised window natively;
    // a failed activation aborts before any input is injected.
    if (!native.activateWindow(id)) {
      throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target window could not be activated or is not on screen', 'RETRY')
    }
  }

  /** Activate AND require the target to actually be the frontmost app. */
  private async assertForeground(id: string): Promise<void> {
    await this.activateWindow(id)
    const native = await this.native()
    if (!native.isFrontmost(id)) {
      throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target application is not the frontmost app; input was not sent', 'RETRY')
    }
  }

  async accessibilityTree(id: string): Promise<AccessibilitySnapshot> {
    const native = await this.native()
    const tree = native.accessibilityTree(id, TREE_MAX_NODES, TREE_MAX_DEPTH)
    return {
      nodes: tree.nodes.map(toAccessibilityNode),
      checksum: tree.checksum,
      mode: tree.mode,
      truncated: tree.truncated,
    }
  }

  async click(request: ClickRequest): Promise<ActionResult> {
    const native = await this.native()
    const button = request.button
    if (request.elementId) {
      try {
        if (native.elementClick(request.windowId, request.elementId, request.count)) {
          return { ok: true, method: 'ax-press', details: { elementId: request.elementId } }
        }
      } catch { /* fall through to pixel click */ }
    }
    const screen = await this.toScreenPoint(request)
    await this.assertForeground(request.windowId)
    if (!native.moveCursor(screen.x, screen.y)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse movement failed', 'RETRY')
    if (!native.click(button, request.count)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse click failed', 'RETRY')
    return { ok: true, method: 'cg-event', details: { x: screen.x, y: screen.y, button, count: request.count } }
  }

  async typeText(request: TypeTextRequest): Promise<ActionResult> {
    const native = await this.native()
    await this.assertForeground(request.windowId)
    const key = request.clipboardKey ?? 'default'
    const saved = native.saveClipboard(key)
    try {
      if (saved && native.setClipboardText(request.text) && native.paste()) {
        // Cmd+V is processed asynchronously by the target; give it time to
        // read the clipboard before restoring the previous content (same
        // settle delay as the Windows provider).
        await new Promise((resolve) => setTimeout(resolve, 300))
        return { ok: true, method: 'clipboard-paste', details: { chars: request.text.length } }
      }
    } finally {
      if (saved && !native.restoreClipboard(key)) {
        // A failed restore would leave the just-typed (possibly secret) text on
        // the shared pasteboard; wiping is the safe fallback.
        try { native.setClipboardText('') } catch { /* best effort */ }
      }
    }
    // Mirror the Windows cap: the per-char injection fallback must stay
    // bounded in case a native implementation paces keystrokes.
    if (request.text.length > 1000) {
      throw new ComputerUseError(
        'INPUT_TOO_LARGE',
        'Clipboard paste is unavailable and the keyboard fallback supports at most 1000 characters per call; please type in smaller chunks',
        'DENY',
      )
    }
    if (native.typeText(request.text)) {
      return { ok: true, method: 'unicode-injection', details: { chars: request.text.length } }
    }
    throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Text input failed', 'RETRY')
  }

  async pressKey(request: PressKeyRequest): Promise<ActionResult> {
    const native = await this.native()
    const key = request.key.trim()
    const tokens = key.split('+').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (!tokens.length) throw new ComputerUseError('UNSUPPORTED_KEY', `Unsupported key: ${key}`, 'DENY')
    // Meta keys are banned entirely and system chords are rejected up front.
    if (tokens.some((t) => META_MODIFIERS.has(t))) {
      throw new ComputerUseError('FORBIDDEN_KEY', 'Command/Meta shortcuts are not allowed', 'DENY')
    }
    const main = tokens.pop()!
    const code = resolveKeyCode(main)
    if (code === undefined) throw new ComputerUseError('UNSUPPORTED_KEY', `Unsupported key: ${main}`, 'DENY')
    const mods = tokens.map((t) => resolveKeyCode(t))
    if (mods.some((c) => c === undefined)) throw new ComputerUseError('UNSUPPORTED_MODIFIER', 'Unsupported modifier key', 'DENY')
    if (isForbiddenMacChord(tokens, main)) throw new ComputerUseError('FORBIDDEN_KEY', 'System shortcut combinations are not allowed', 'DENY')
    await this.assertForeground(request.windowId)
    const held: number[] = []
    let mainHeld = false
    try {
      for (const mod of mods) {
        if (!native.pressKey(mod!, true)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to press modifier key', 'RETRY')
        held.push(mod!)
      }
      if (!native.pressKey(code, true)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to send key', 'RETRY')
      mainHeld = true
      if (!native.pressKey(code, false)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to release key', 'RETRY')
      mainHeld = false
    } finally {
      // Never leave a modifier held down, even on failure.
      if (mainHeld) native.pressKey(code, false)
      for (const mod of [...held].reverse()) native.pressKey(mod, false)
    }
    return { ok: true, method: 'cg-keyboard', details: { key, modifiers: mods.length } }
  }

  async scroll(request: ScrollRequest): Promise<ActionResult> {
    const native = await this.native()
    const screen = await this.toScreenPoint(request)
    await this.assertForeground(request.windowId)
    if (!native.moveCursor(screen.x, screen.y)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse movement failed', 'RETRY')
    if (!native.scroll(screen.x, screen.y, request.scrollX, request.scrollY)) {
      throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse wheel input failed', 'RETRY')
    }
    return { ok: true, method: 'cg-scroll', details: { x: screen.x, y: screen.y, scrollX: request.scrollX, scrollY: request.scrollY } }
  }

  async drag(request: DragRequest): Promise<ActionResult> {
    const native = await this.native()
    const from = await this.toScreenPoint({ windowId: request.windowId, x: request.fromX, y: request.fromY, coordinateSpace: request.coordinateSpace })
    const to = await this.toScreenPoint({ windowId: request.windowId, x: request.toX, y: request.toY, coordinateSpace: request.coordinateSpace })
    await this.assertForeground(request.windowId)
    if (!native.drag(from.x, from.y, to.x, to.y)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse drag failed', 'RETRY')
    return { ok: true, method: 'cg-drag', details: { from, to } }
  }

  async launchApp(request: LaunchRequest): Promise<LaunchResult> {
    const { spawn } = await import('node:child_process')
    const { app, args } = checkLaunchApp(request.app, request.args)
    const child = spawn('open', ['-a', app, '--args', ...args], { detached: true, stdio: 'ignore' })
    child.unref()
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true))
      child.once('error', () => resolve(false))
    })
    if (!started) throw new ComputerUseError('NATIVE_LAUNCH_FAILED', 'Application launch failed; please verify the path or app name', 'NONE')
    return { launched: app, args, requiresObservation: true }
  }

  async saveClipboard(key?: string): Promise<boolean> {
    const native = await this.native()
    return native.saveClipboard(typeof key === 'string' ? key : 'default')
  }

  async restoreClipboard(key?: string): Promise<boolean> {
    const native = await this.native()
    return native.restoreClipboard(typeof key === 'string' ? key : 'default')
  }

  private overlayHandle = 0

  async startIndicator(target?: string): Promise<void> {
    const native = await this.native()
    if (!this.overlayHandle) {
      try { this.overlayHandle = native.overlayCreate() } catch { return }
    }
    try { native.overlayShow(this.overlayHandle, target ?? '', 'DSH is operating the computer') } catch { /* best effort */ }
  }

  async stopIndicator(): Promise<void> {
    const native = await this.native()
    if (this.overlayHandle) {
      try { native.overlayHide(this.overlayHandle, true) } catch { /* best effort */ }
    }
  }

  async dispose(): Promise<void> {
    await this.stopIndicator().catch(() => undefined)
    // Release pasteboard snapshots captured by paste flows whose session
    // ended without a restore (same teardown the Windows provider does).
    try {
      const native = await this.native().catch(() => null)
      native?.clearClipboardSnapshots()
    } catch { /* best effort */ }
  }

  private async toScreenPoint(request: { windowId: string; x: number; y: number; coordinateSpace?: string }): Promise<{ x: number; y: number }> {
    const native = await this.native()
    const window = native.getWindow(request.windowId)
    const r = window.rect
    const space = request.coordinateSpace ?? 'auto'
    if (space === 'screen') {
      if (!Number.isInteger(request.x) || !Number.isInteger(request.y) || request.x < r.left || request.y < r.top || request.x >= r.right || request.y >= r.bottom) {
        throw new ComputerUseError('COORDINATE_OUT_OF_BOUNDS', `Screen coordinates (${request.x}, ${request.y}) are outside the target window`, 'REQUIRES_REFRESH')
      }
      return { x: request.x, y: request.y }
    }
    if (!Number.isInteger(request.x) || !Number.isInteger(request.y) || request.x < 0 || request.y < 0 || request.x >= r.width || request.y >= r.height) {
      throw new ComputerUseError('COORDINATE_OUT_OF_BOUNDS', `Coordinates (${request.x}, ${request.y}) are outside the window bounds ${r.width}x${r.height}`, 'REQUIRES_REFRESH')
    }
    return { x: r.left + request.x, y: r.top + request.y }
  }
}