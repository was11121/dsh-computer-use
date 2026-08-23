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
import type { Capabilities } from './capability.ts';
import { ComputerUseError } from './errors.ts';
import type { AccessibilitySnapshot, ActionResult, CaptureResult, ClickRequest, DesktopProvider, DesktopWindow, DragRequest, LaunchRequest, LaunchResult, PressKeyRequest, RuntimeInfo, ScrollRequest, TypeTextRequest, WindowId } from './types.ts';
export interface GuardHooks {
    /** Throw when `allowControl` is disabled. */
    assertAllowed(): void;
    /** Optional interactive approval for high-risk actions. */
    approve?(reason: string): Promise<void>;
}
/** Official guarded entry point for desktop-control providers. */
export declare class GuardedDesktopProvider implements DesktopProvider {
    private readonly inner;
    private readonly hooks;
    constructor(inner: DesktopProvider, hooks: GuardHooks);
    private gate;
    private gateAsync;
    runtimeInfo(): RuntimeInfo;
    capabilities(): Capabilities;
    listWindows(): Promise<DesktopWindow[]>;
    getWindow(id: WindowId): Promise<DesktopWindow>;
    captureWindow(id: WindowId, path: string): Promise<CaptureResult>;
    activateWindow(id: WindowId): Promise<void>;
    accessibilityTree(id: WindowId): Promise<AccessibilitySnapshot>;
    /**
     * Re-verify the observed window generation right before a primitive runs.
     * Without this delegation the TOCTOU narrowing in `core/actions.ts`
     * (`ctx.provider.assertIdentity`) silently never fires, because the guarded
     * wrapper hid the inner provider's implementation.
     */
    assertIdentity(id: WindowId, generation?: number): Promise<void>;
    click(request: ClickRequest): Promise<ActionResult>;
    typeText(request: TypeTextRequest): Promise<ActionResult>;
    pressKey(request: PressKeyRequest): Promise<ActionResult>;
    scroll(request: ScrollRequest): Promise<ActionResult>;
    drag(request: DragRequest): Promise<ActionResult>;
    launchApp(request: LaunchRequest): Promise<LaunchResult>;
    saveClipboard(): Promise<boolean>;
    restoreClipboard(): Promise<boolean>;
    startIndicator(target?: WindowId): Promise<void>;
    stopIndicator(): Promise<void>;
    dispose(): Promise<void>;
}
/** Convenience factory. */
export declare function guardProvider(provider: DesktopProvider, hooks: GuardHooks): GuardedDesktopProvider;
/** Error used when a capability is entirely unavailable. */
export declare function capabilityUnavailableError(capability: keyof Capabilities): ComputerUseError;
