/**
 * Guarded provider wrapper.
 *
 * The core cannot force every caller to go through a single chokepoint, but it
 * provides this wrapper as the *official* production entry so host permission,
 * approval and capability gates run before any provider primitive is touched.
 * Use it in the Windows/macOS/Linux package entry points instead of calling a
 * raw `DesktopProvider` directly.
 * @module
 */

import { assertCapability } from './types.ts'
import type { Capabilities } from './capability.ts'
import { ComputerUseError } from './errors.ts'
import type {
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
  WindowId,
} from './types.ts'

export interface GuardHooks {
  /** Throw when `allowControl` is disabled. */
  assertAllowed(): void
  /** Optional interactive approval for high-risk actions. */
  approve?(reason: string): Promise<void>
}

/** Official guarded entry point for desktop-control providers. */
export class GuardedDesktopProvider implements DesktopProvider {
  private readonly inner: DesktopProvider
  private readonly hooks: GuardHooks

  constructor(inner: DesktopProvider, hooks: GuardHooks) {
    this.inner = inner
    this.hooks = hooks
  }

  private gate(capability: keyof Capabilities, reason: string): void {
    assertCapability(this.inner.capabilities()[capability], capability)
    this.hooks.assertAllowed()
  }

  private async gateAsync(capability: keyof Capabilities, reason: string): Promise<void> {
    this.gate(capability, reason)
    if (this.hooks.approve) await this.hooks.approve(reason)
  }

  runtimeInfo(): RuntimeInfo {
    return this.inner.runtimeInfo()
  }

  capabilities(): Capabilities {
    return this.inner.capabilities()
  }

  async listWindows(): Promise<DesktopWindow[]> {
    this.gate('windowEnumeration', 'list windows')
    return this.inner.listWindows()
  }

  async getWindow(id: WindowId): Promise<DesktopWindow> {
    this.gate('windowEnumeration', 'get window')
    return this.inner.getWindow(id)
  }

  async captureWindow(id: WindowId, path: string): Promise<CaptureResult> {
    await this.gateAsync('windowCapture', 'capture window')
    return this.inner.captureWindow(id, path)
  }

  async activateWindow(id: WindowId): Promise<void> {
    await this.gateAsync('windowEnumeration', 'activate window')
    return this.inner.activateWindow(id)
  }

  async accessibilityTree(id: WindowId): Promise<AccessibilitySnapshot> {
    this.gate('accessibilityTree', 'read accessibility tree')
    return this.inner.accessibilityTree(id)
  }

  /**
   * Re-verify the observed window generation right before a primitive runs.
   * Without this delegation the TOCTOU narrowing in `core/actions.ts`
   * (`ctx.provider.assertIdentity`) silently never fires, because the guarded
   * wrapper hid the inner provider's implementation.
   */
  async assertIdentity(id: WindowId, generation?: number): Promise<void> {
    this.gate('windowEnumeration', 'verify window identity')
    await this.inner.assertIdentity?.(id, generation)
  }

  async click(request: ClickRequest): Promise<ActionResult> {
    await this.gateAsync('foregroundInput', 'simulate mouse click')
    return this.inner.click(request)
  }

  async typeText(request: TypeTextRequest): Promise<ActionResult> {
    await this.gateAsync('foregroundInput', 'type text')
    return this.inner.typeText(request)
  }

  async pressKey(request: PressKeyRequest): Promise<ActionResult> {
    await this.gateAsync('foregroundInput', 'send key')
    return this.inner.pressKey(request)
  }

  async scroll(request: ScrollRequest): Promise<ActionResult> {
    await this.gateAsync('foregroundInput', 'scroll')
    return this.inner.scroll(request)
  }

  async drag(request: DragRequest): Promise<ActionResult> {
    await this.gateAsync('foregroundInput', 'drag')
    return this.inner.drag(request)
  }

  async launchApp(request: LaunchRequest): Promise<LaunchResult> {
    await this.gateAsync('launchApp', `launch application ${request.app}`)
    return this.inner.launchApp(request)
  }

  async saveClipboard(): Promise<boolean> {
    this.gate('clipboard', 'save clipboard')
    return this.inner.saveClipboard()
  }

  async restoreClipboard(): Promise<boolean> {
    this.gate('clipboardRestore', 'restore clipboard')
    return this.inner.restoreClipboard()
  }

  async startIndicator(target?: WindowId): Promise<void> {
    this.gate('overlay', 'show control indicator')
    return this.inner.startIndicator(target)
  }

  async stopIndicator(): Promise<void> {
    this.gate('overlay', 'hide control indicator')
    return this.inner.stopIndicator()
  }

  async dispose(): Promise<void> {
    await this.inner.dispose()
  }
}

/** Convenience factory. */
export function guardProvider(provider: DesktopProvider, hooks: GuardHooks): GuardedDesktopProvider {
  return new GuardedDesktopProvider(provider, hooks)
}

/** Error used when a capability is entirely unavailable. */
export function capabilityUnavailableError(capability: keyof Capabilities): ComputerUseError {
  return new ComputerUseError('CAPABILITY_UNAVAILABLE', `Capability is not available: ${capability}`, 'NONE')
}
