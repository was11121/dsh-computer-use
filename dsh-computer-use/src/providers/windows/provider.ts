/**
 * Windows provider: implements `DesktopProvider` over the existing Node-API
 * addon (`dsh-computer-use-native`).
 *
 * This is the production implementation of the provider contract — the single
 * platform adapter the guarded runtime calls into. It keeps accepting the
 * legacy numeric HWND through `win:hWnd:` string ids while the native layer
 * continues to operate on the raw HWND.
 *
 * Safety properties implemented here (mirroring the legacy runtime baseline):
 * - activation is verified (foreground/visible/on-screen) before input;
 * - when activation is refused, background-safe UIA invoke / PostMessage
 *   fallbacks are used instead of falling back to raw global input;
 * - `assertIdentity` re-verifies the exact observed window generation right
 *   before a primitive runs (TOCTOU narrowing);
 * - clipboard snapshots are keyed by session so concurrent/cross-session
 *   paste flows cannot restore the wrong content.
 * @module
 */

import * as native from 'dsh-computer-use-native'
import { ComputerUseError } from '../../core/errors.ts'
import { resolveWindowId, extractLegacyHwnd, type WindowId } from '../../core/identity.ts'
import { windowsCapabilities, type Capabilities } from '../../core/capability.ts'
import { checkLaunchApp } from '../../core/app-launch.ts'
import { META_KEY_TOKENS } from '../../core/types.ts'
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
  MouseButton,
} from '../../core/types.ts'

const TREE_MAX_NODES = 2000
const TREE_MAX_DEPTH = 32
// Per-call cap for the SendInput text fallback (~10ms/char native pacing
// blocks the event loop: 1000 chars ≈ 10s, the largest freeze we accept).
const SENDINPUT_TEXT_LIMIT = 1000

// Windows VK codes for the computer_press_key tool. Kept in the Windows
// provider so it does not depend on the legacy runtime observation path.
const WINDOWS_KEY_CODES: Record<string, number> = {
  enter: 13, return: 13, tab: 9, escape: 27, esc: 27, space: 32,
  backspace: 8, delete: 46, insert: 45, home: 36, end: 35, pageup: 33, pagedown: 34,
  up: 38, down: 40, left: 37, right: 39,
  ctrl: 17, control: 17, shift: 16, alt: 18,
  control_l: 0xA2, control_r: 0xA3, shift_l: 0xA0, shift_r: 0xA1, alt_l: 0xA4, alt_r: 0xA5,
  capslock: 20, numlock: 144, scrolllock: 145, printscreen: 44, pause: 19,
  '.': 0xBE, ',': 0xBC, '/': 0xBF, '\\': 0xDC, ';': 0xBA, "'": 0xDE,
  '[': 0xDB, ']': 0xDD, '-': 0xBD, '=': 0xBB, '`': 0xC0,
}
for (let i = 0; i <= 9; i++) {
  WINDOWS_KEY_CODES[`kp_${i}`] = 0x60 + i
  WINDOWS_KEY_CODES[`numpad_${i}`] = 0x60 + i
}
WINDOWS_KEY_CODES.numpad_add = 0x6B
WINDOWS_KEY_CODES.numpad_subtract = 0x6D
WINDOWS_KEY_CODES.numpad_multiply = 0x6A
WINDOWS_KEY_CODES.numpad_divide = 0x6F
WINDOWS_KEY_CODES.numpad_decimal = 0x6E
for (let i = 1; i <= 24; i++) WINDOWS_KEY_CODES[`f${i}`] = 0x70 + (i - 1)

// System-level chords that must never be sent even though they do not use the
// Windows/Meta key.
const FORBIDDEN_CHORDS: { mods: string[]; key: string }[] = [
  { mods: ['alt'], key: 'tab' },
  { mods: ['alt'], key: 'f4' },
  { mods: ['alt'], key: 'esc' },
  { mods: ['alt'], key: 'space' },
  { mods: ['ctrl'], key: 'esc' },
  { mods: ['ctrl', 'shift'], key: 'esc' },
  { mods: ['ctrl', 'alt'], key: 'delete' },
]
function isForbiddenChord(mods: string[], main: string): boolean {
  return FORBIDDEN_CHORDS.some((c) => c.key === main && c.mods.every((m) => mods.includes(m)))
}

function hwnd(id: WindowId): number {
  const value = extractLegacyHwnd(id)
  if (value === undefined) {
    throw new ComputerUseError('WINDOW_NOT_FOUND', `Not a Windows HWND: ${id}`, 'REQUIRES_REFRESH')
  }
  return value
}

function toDesktopWindow(w: native.WindowIdentity): DesktopWindow {
  return {
    windowId: resolveWindowId(w.windowId),
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
    generation: w.generation,
  }
}

function toAccessibilityNode(n: native.AccessibilityNode): AccessibilityNode {
  return {
    elementId: `win:uia:${n.index}`,
    elementIndex: n.index,
    parent: n.parent >= 0 ? `win:uia:${n.parent}` : undefined,
    role: String(n.role),
    name: n.name,
    automationId: n.automationId,
    rect: n.rect ? { ...n.rect } : undefined,
    enabled: n.enabled,
    visible: n.visible,
    childCount: n.childCount,
  }
}

function toActionResult(method: string, details: Record<string, unknown> = {}, limitations: string[] = []): ActionResult {
  return { ok: true, method, details, limitations }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Windows implementation of `DesktopProvider`.
 *
 * The core (observation/approval/permission) belongs to the shared core; this
 * class is intentionally a thin adapter over the native addon.
 */
export class WindowsProvider implements DesktopProvider {
  runtimeInfo(): RuntimeInfo {
    const info = native.runtimeInfo()
    return { ...info, provider: 'windows', capabilities: this.capabilities() }
  }

  capabilities(): Capabilities {
    return windowsCapabilities()
  }

  async listWindows(): Promise<DesktopWindow[]> {
    return native.listWindows().map(toDesktopWindow)
  }

  async getWindow(id: WindowId): Promise<DesktopWindow> {
    const window = native.getWindow(hwnd(id))
    if (!window) throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH')
    return toDesktopWindow(window)
  }

  async assertIdentity(id: WindowId, generation?: number): Promise<void> {
    const value = hwnd(id)
    if (!native.verifyWindow(value, generation ?? 0)) {
      throw new ComputerUseError('WINDOW_IDENTITY_CHANGED', 'The target window was replaced since the observation; please re-observe', 'REQUIRES_REFRESH')
    }
  }

  async captureWindow(id: WindowId, path: string): Promise<CaptureResult> {
    const value = hwnd(id)
    const window = native.getWindow(value)
    if (!window) throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH')
    const rect = window.rect
    // Restore a minimized target so its own content can be captured. The
    // native layer captures the window itself (PrintWindow first, screen
    // fallback), so occluding windows never leak into the image.
    try {
      await this.activateWindow(id)
    } catch { /* capture may still work for visible windows */ }
    if (!native.captureWindow(value, path)) {
      throw new ComputerUseError('NATIVE_CAPTURE_FAILED', 'Window capture failed', 'RETRY')
    }
    // Re-read the rect after activation: restoring a minimized window moves it.
    let finalRect = rect
    try { finalRect = native.getWindow(value).rect } catch { /* keep pre-capture rect */ }
    return { path, rect: { ...finalRect } }
  }

  async activateWindow(id: WindowId): Promise<void> {
    const value = hwnd(id)
    if (!native.activateWindow(value)) {
      throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target window could not be activated or is not on screen', 'RETRY')
    }
    // Verify the activation actually landed before any input is injected.
    const current = native.getWindow(value)
    if (!current.foreground || !current.visible || current.minimized || !current.onScreen ||
        !current.rect.width || !current.rect.height) {
      throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target window did not become the foreground visible window', 'RETRY')
    }
  }

  async accessibilityTree(id: WindowId): Promise<AccessibilitySnapshot> {
    const tree = native.accessibilityTree(hwnd(id), TREE_MAX_NODES, TREE_MAX_DEPTH)
    return {
      nodes: tree.nodes.map(toAccessibilityNode),
      checksum: tree.checksum,
      mode: tree.mode,
      truncated: tree.truncated,
    }
  }

  async click(request: ClickRequest): Promise<ActionResult> {
    const id = hwnd(request.windowId)
    const button: MouseButton = request.button
    if (request.elementIndex !== undefined || request.elementId !== undefined) {
      const index = request.elementIndex ?? this.resolveElementIndex(request.elementId)
      try {
        if (native.elementClick(id, index, request.count, TREE_MAX_NODES, TREE_MAX_DEPTH)) {
          return toActionResult('uia-element', { elementIndex: index, button, count: request.count })
        }
      } catch { /* pattern invoke unavailable; fall through */ }
    }
    const screen = this.toScreenPoint(request)
    const clicks = Math.max(1, Math.min(3, request.count))
    if (request.clickMethod === 'post') {
      if (!native.postClick(id, screen.x, screen.y, button, clicks)) {
        throw new ComputerUseError('NATIVE_INPUT_FAILED', 'PostMessage click failed', 'RETRY')
      }
      return toActionResult('post', { x: screen.x, y: screen.y, button, count: clicks })
    }
    try {
      await this.activateWindow(request.windowId)
    } catch (error) {
      // Background-safe fallback: UIA invoke at the point when foreground
      // activation is refused, never raw global input on a wrong window.
      if (error instanceof ComputerUseError && error.code === 'NATIVE_ACTIVATE_FAILED' &&
          button === 'left' && this.invokeBackground(id, screen.x, screen.y, clicks)) {
        return toActionResult('uia-background-invoke', { x: screen.x, y: screen.y, count: clicks })
      }
      throw error
    }
    if (!native.moveCursor(screen.x, screen.y)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse movement failed', 'RETRY')
    if (!native.click(button, clicks)) {
      if (button === 'left' && this.invokeBackground(id, screen.x, screen.y, clicks)) {
        return toActionResult('uia-background-invoke', { x: screen.x, y: screen.y, count: clicks })
      }
      throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse click failed', 'RETRY')
    }
    return toActionResult('foreground', { x: screen.x, y: screen.y, button, count: clicks })
  }

  private invokeBackground(id: number, x: number, y: number, count: number): boolean {
    try {
      return native.moveCursor(x, y) && native.invokeAtPoint(id, x, y, count)
    } catch {
      return false
    }
  }

  async typeText(request: TypeTextRequest): Promise<ActionResult> {
    await this.activateWindow(request.windowId)
    const key = request.clipboardKey ?? 'default'
    const saved = native.saveClipboard(key)
    try {
      if (saved && native.setClipboardText(request.text) && native.paste()) {
        // Ctrl+V is processed asynchronously by the target; give it time to
        // read the clipboard before restoring the previous content.
        await delay(300)
        return toActionResult('clipboard-paste', { chars: request.text.length })
      }
    } finally {
      if (saved && !native.restoreClipboard(key)) {
        // A failed restore would leave the just-typed (possibly secret) text on
        // the shared system clipboard; wiping is the safe fallback.
        try { native.setClipboardText('') } catch { /* best effort */ }
      }
    }
    // The native SendInput fallback paces at ~10ms per char and blocks the JS
    // event loop, so a large payload would freeze the engine for minutes —
    // tool timeouts cannot even fire while the native call blocks. The
    // clipboard path above handles large payloads; keep the fallback bounded.
    if (request.text.length > SENDINPUT_TEXT_LIMIT) {
      throw new ComputerUseError(
        'INPUT_TOO_LARGE',
        `Clipboard paste is unavailable and the keyboard fallback supports at most ${SENDINPUT_TEXT_LIMIT} characters per call; please type in smaller chunks`,
        'DENY',
      )
    }
    if (native.typeText(request.text)) {
      return toActionResult('sendinput-unicode', { chars: request.text.length })
    }
    throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Text input failed', 'RETRY')
  }

  async pressKey(request: PressKeyRequest): Promise<ActionResult> {
    const value = request.key
    const tokens = value.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean)
    // Same shared token set as the runtime layer (covers X11 keysym spellings
    // like super_l/meta_l too); a duplicated short list here would drift.
    if (!tokens.length || tokens.some((x) => META_KEY_TOKENS.has(x))) {
      throw new ComputerUseError('FORBIDDEN_KEY', 'Windows/Meta shortcuts are not allowed', 'DENY')
    }
    const main = tokens.pop()!
    const mainCode = WINDOWS_KEY_CODES[main] ?? (main.length === 1 && /[a-z0-9]/i.test(main) ? main.toUpperCase().charCodeAt(0) : undefined)
    if (mainCode === undefined) throw new ComputerUseError('UNSUPPORTED_KEY', `Unsupported key: ${main}`, 'DENY')
    const mods = tokens.map((x) => WINDOWS_KEY_CODES[x])
    if (mods.some((code) => code === undefined)) throw new ComputerUseError('UNSUPPORTED_MODIFIER', 'Unsupported modifier key', 'DENY')
    if (isForbiddenChord(tokens, main)) throw new ComputerUseError('FORBIDDEN_KEY', 'System shortcut combinations are not allowed', 'DENY')
    // PrintScreen copies the whole multi-monitor desktop into the shared
    // clipboard, breaking the window-isolated capture promise.
    if (main === 'printscreen') throw new ComputerUseError('FORBIDDEN_KEY', 'Full-screen capture keys are not allowed', 'DENY')
    await this.activateWindow(request.windowId)
    const held: number[] = []
    let mainHeld = false
    try {
      for (const code of mods) {
        if (!native.pressKey(code, true)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to press modifier key', 'RETRY')
        held.push(code)
      }
      if (!native.pressKey(mainCode, true)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to send key', 'RETRY')
      mainHeld = true
      if (!native.pressKey(mainCode, false)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Failed to release key', 'RETRY')
      mainHeld = false
    } finally {
      if (mainHeld) native.pressKey(mainCode, false)
      for (const code of held.reverse()) native.pressKey(code, false)
    }
    return toActionResult('keyboard', { key: value, modifiers: mods.length })
  }

  async scroll(request: ScrollRequest): Promise<ActionResult> {
    const id = hwnd(request.windowId)
    const screen = this.toScreenPoint(request)
    const dx = Math.max(-20_000, Math.min(20_000, request.scrollX))
    const dy = Math.max(-20_000, Math.min(20_000, request.scrollY))
    try {
      await this.activateWindow(request.windowId)
    } catch (error) {
      if (error instanceof ComputerUseError && error.code === 'NATIVE_ACTIVATE_FAILED') {
        // Background-safe wheel: two PostMessage deltas, one per axis.
        const postedX = dx === 0 || native.postWheel(id, screen.x, screen.y, dx, true)
        const postedY = dy === 0 || native.postWheel(id, screen.x, screen.y, dy, false)
        if (postedX && postedY) {
          return toActionResult('post-wheel', { x: screen.x, y: screen.y, scrollX: dx, scrollY: dy })
        }
      }
      throw error
    }
    if (!native.moveCursor(screen.x, screen.y)) throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse movement failed', 'RETRY')
    if (!native.scroll(screen.x, screen.y, dx, dy)) {
      throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse wheel input failed', 'RETRY')
    }
    return toActionResult('foreground', { x: screen.x, y: screen.y, scrollX: dx, scrollY: dy })
  }

  async drag(request: DragRequest): Promise<ActionResult> {
    const from = this.toScreenPoint({ windowId: request.windowId, x: request.fromX, y: request.fromY, coordinateSpace: request.coordinateSpace })
    const to = this.toScreenPoint({ windowId: request.windowId, x: request.toX, y: request.toY, coordinateSpace: request.coordinateSpace })
    await this.activateWindow(request.windowId)
    if (!native.drag(from.x, from.y, to.x, to.y)) {
      throw new ComputerUseError('NATIVE_INPUT_FAILED', 'Mouse drag failed', 'RETRY')
    }
    return toActionResult('foreground', { from, to })
  }

  async launchApp(request: LaunchRequest): Promise<LaunchResult> {
    const { spawn } = await import('node:child_process')
    const { app, args: launchArgs } = checkLaunchApp(request.app, request.args)
    // Browser launches force a new window so DSH chat is never overlaid.
    const forcedNewWindow = this.forceNewWindowIfBrowser(app, launchArgs)
    const child = spawn(app, launchArgs, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true))
      child.once('error', () => resolve(false))
    })
    if (!started) throw new ComputerUseError('NATIVE_LAUNCH_FAILED', 'Application launch failed; please verify the path or app name', 'NONE')
    return { launched: app, args: launchArgs, forcedNewWindow, requiresObservation: true }
  }

  private forceNewWindowIfBrowser(app: string, args: string[]): boolean {
    const BROWSER_HINTS = ['firefox', 'msedge', 'chrome', 'edge', 'brave', 'opera', 'vivaldi']
    const appLower = app.toLowerCase()
    if (!BROWSER_HINTS.some((h) => appLower.includes(h))) return false
    if (args.some((a) => ['--new-window', '-new-window'].includes(a.toLowerCase()))) return false
    args.unshift('--new-window')
    return true
  }

  async saveClipboard(key?: string): Promise<boolean> {
    return key ? native.saveClipboard(key) : native.saveClipboard()
  }

  async restoreClipboard(key?: string): Promise<boolean> {
    return key ? native.restoreClipboard(key) : native.restoreClipboard()
  }

  private overlayHandle = 0

  async startIndicator(target?: WindowId): Promise<void> {
    if (!this.overlayHandle) {
      try { this.overlayHandle = native.overlayCreate() } catch { return }
    }
    try {
      native.overlayShow(this.overlayHandle, target ? hwnd(target) : 0, 'DSH is operating the computer')
    } catch { /* best effort */ }
  }

  async refreshIndicator(): Promise<void> {
    if (this.overlayHandle) {
      try { native.overlayRefresh(this.overlayHandle) } catch { /* best effort */ }
    }
  }

  async stopIndicator(): Promise<void> {
    if (this.overlayHandle) {
      try { native.overlayHide(this.overlayHandle, true) } catch { /* best effort */ }
    }
  }

  async dispose(): Promise<void> {
    await this.stopIndicator()
    if (this.overlayHandle) {
      try { native.overlayDestroy(this.overlayHandle) } catch { /* best effort */ }
      this.overlayHandle = 0
    }
    try { native.restoreSystemCursors() } catch { /* best effort */ }
    // Release clipboard snapshots captured by paste flows whose session ended
    // without a restore; each one pins an IDataObject and a COM apartment.
    try { native.clearClipboardSnapshots() } catch { /* best effort */ }
  }

  private resolveElementIndex(elementId?: string): number {
    if (!elementId) return -1
    const match = /^win:uia:(\d+)$/.exec(elementId)
    if (!match) return -1
    return Number.parseInt(match[1], 10)
  }

  private toScreenPoint(request: { windowId: WindowId; x: number; y: number; coordinateSpace?: string }): { x: number; y: number } {
    const window = native.getWindow(hwnd(request.windowId))
    if (!window) throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${request.windowId} does not exist`, 'REQUIRES_REFRESH')
    const r = window.rect
    const space = request.coordinateSpace ?? 'auto'
    if (space === 'screen') {
      if (
        !Number.isInteger(request.x) || !Number.isInteger(request.y) ||
        request.x < r.left || request.y < r.top ||
        request.x >= r.right || request.y >= r.bottom
      ) {
        throw new ComputerUseError('COORDINATE_OUT_OF_BOUNDS', `Screen coordinates (${request.x}, ${request.y}) are outside the target window`, 'REQUIRES_REFRESH')
      }
      return { x: request.x, y: request.y }
    }
    if (
      !Number.isInteger(request.x) || !Number.isInteger(request.y) ||
      request.x < 0 || request.y < 0 ||
      request.x >= r.width || request.y >= r.height
    ) {
      throw new ComputerUseError('COORDINATE_OUT_OF_BOUNDS', `Coordinates (${request.x}, ${request.y}) are outside the window bounds ${r.width}x${r.height}`, 'REQUIRES_REFRESH')
    }
    return { x: r.left + request.x, y: r.top + request.y }
  }
}