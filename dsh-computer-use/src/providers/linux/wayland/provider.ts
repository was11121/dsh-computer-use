/**
 * Linux Wayland provider (restricted compatibility mode).
 *
 * Wayland does not allow global window enumeration or synthetic input the way
 * X11/Windows do. This provider explicitly reports limited capabilities and
 * uses xdg-desktop-portal / AT-SPI where possible. It never silently falls
 * back to X11.
 * @module
 */

import { ComputerUseError } from '../../../core/errors.ts'
import { checkLaunchApp } from '../../../core/app-launch.ts'
import type { Capabilities } from '../../../core/capability.ts'
import type {
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
  AccessibilitySnapshot,
} from '../../../core/types.ts'

function unavailable(feature: string): ComputerUseError {
  return new ComputerUseError('CAPABILITY_UNAVAILABLE', `${feature} is not available on Wayland`, 'NONE')
}

/**
 * Wayland provider.
 *
 * Initial support is limited to launching apps and best-effort clipboard.
 * Window enumeration/capture/input are gated by capability checks in the core.
 */
export class WaylandProvider implements DesktopProvider {
  runtimeInfo(): RuntimeInfo {
    return {
      platform: 'linux',
      arch: process.arch,
      node: process.version,
      napi: undefined,
      provider: 'wayland',
      capabilities: this.capabilities(),
    }
  }

  capabilities(): Capabilities {
    // Current Wayland backend is a restricted scaffold. Capabilities are
    // conservative (false) until the portal/AT-SPI implementations land, so
    // the core never routes actions to unimplemented paths.
    return {
      windowEnumeration: false,
      windowCapture: false,
      accessibilityTree: false,
      foregroundInput: false,
      backgroundInput: false,
      semanticClick: false,
      clipboard: 'limited',
      clipboardRestore: false,
      overlay: false,
      launchApp: true,
    }
  }

  async listWindows(): Promise<DesktopWindow[]> {
    throw unavailable('Window enumeration')
  }

  async getWindow(id: string): Promise<DesktopWindow> {
    throw unavailable('Window lookup')
  }

  async captureWindow(id: string, path: string): Promise<CaptureResult> {
    throw unavailable('Window capture')
  }

  async activateWindow(id: string): Promise<void> {
    throw unavailable('Window activation')
  }

  async accessibilityTree(id: string): Promise<AccessibilitySnapshot> {
    throw unavailable('Accessibility tree')
  }

  async click(request: ClickRequest): Promise<ActionResult> {
    throw unavailable('Input simulation')
  }

  async typeText(request: TypeTextRequest): Promise<ActionResult> {
    throw unavailable('Text input')
  }

  async pressKey(request: PressKeyRequest): Promise<ActionResult> {
    throw unavailable('Key input')
  }

  async scroll(request: ScrollRequest): Promise<ActionResult> {
    throw unavailable('Scrolling')
  }

  async drag(request: DragRequest): Promise<ActionResult> {
    throw unavailable('Dragging')
  }

  async launchApp(request: LaunchRequest): Promise<LaunchResult> {
    const { spawn } = await import('node:child_process')
    // Shared hardening (blocked shells/interpreters, control chars, script
    // extensions); a local re-implementation here previously let `bash -c ...`
    // through because the duplicated blocklist only carried Windows names.
    const { app, args } = checkLaunchApp(request.app, request.args)
    const child = spawn(app, args, { detached: true, stdio: 'ignore' })
    child.unref()
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true))
      child.once('error', () => resolve(false))
    })
    if (!started) throw new ComputerUseError('NATIVE_LAUNCH_FAILED', 'Application launch failed; please verify the path or app name', 'NONE')
    return { launched: app, args, requiresObservation: true, limitations: ['Wayland: window may not open in the foreground'] }
  }

  async saveClipboard(): Promise<boolean> {
    // Wayland clipboard persistence depends on the compositor; conservative false.
    return false
  }

  async restoreClipboard(): Promise<boolean> {
    return false
  }

  async startIndicator(target?: string): Promise<void> {
    // Overlay cannot be guaranteed on Wayland; no-op per capability.
  }

  async stopIndicator(): Promise<void> {
    // no-op
  }

  async dispose(): Promise<void> {
    // no-op
  }
}
