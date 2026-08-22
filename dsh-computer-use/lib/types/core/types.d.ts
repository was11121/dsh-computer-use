/**
 * Platform-neutral provider contract.
 *
 * This is the shared `DesktopProvider` interface that Windows, macOS and Linux
 * providers implement. The core owns observation/approval/permission logic;
 * each provider owns only platform primitives.
 *
 * Phase 1 extraction: the Windows provider is the first implementation.
 * @module
 */
import type { Capabilities, CapabilityState } from './capability.ts';
import type { ElementId, WindowId } from './identity.ts';
export type { ElementId, WindowId };
import type { CoordinateSpace } from './point.ts';
/** Rectangle in screen coordinates. */
export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}
/** Platform-neutral window identity returned by providers. */
export interface DesktopWindow {
    /** Opaque cross-platform window id (e.g. `win:hWnd:...`). */
    windowId: WindowId;
    title: string;
    appName: string;
    processId: number;
    processPath: string;
    /** Windows-style class name; empty on platforms without one. */
    className: string;
    /**
     * Optional monotonic per-window generation token. When the underlying OS
     * window is destroyed and a new window reuses the same handle, the token
     * increments; observation validation treats a different token as a different
     * window (TOCTOU guard).
     */
    generation?: number;
    rect: Rect;
    visible: boolean;
    minimized: boolean;
    onScreen: boolean;
    foreground: boolean;
    dpi: number;
}
/** One node of the accessibility tree. */
export interface AccessibilityNode {
    /** Platform element id (stable within an observation). */
    elementId: ElementId;
    /** Legacy Windows UIA index; undefined on other platforms. */
    elementIndex?: number;
    parent?: ElementId;
    role: string;
    name: string;
    automationId?: string;
    rect?: Rect;
    enabled: boolean;
    visible: boolean;
    childCount: number;
}
/** Snapshot returned by `accessibilityTree`. */
export interface AccessibilitySnapshot {
    nodes: AccessibilityNode[];
    checksum: string;
    mode: 'full' | 'top-level' | 'platform';
    truncated: boolean;
}
/** Provider/runtime diagnostic info. */
export interface RuntimeInfo {
    platform: string;
    arch: string;
    node: string;
    napi: string | undefined;
    provider: string;
    capabilities: Capabilities;
}
/** Result of a window capture. */
export interface CaptureResult {
    path: string;
    rect: Rect;
}
/** Mouse button names shared across providers. */
export type MouseButton = 'left' | 'middle' | 'right';
/** Coordinate space accepted by pointer actions (re-exported from point.ts). */
export type { CoordinateSpace } from './point.ts';
/** Request for a pixel-level (or element-level) click. */
export interface ClickRequest {
    windowId: WindowId;
    x: number;
    y: number;
    button: MouseButton;
    count: number;
    elementId?: ElementId;
    elementIndex?: number;
    coordinateSpace?: CoordinateSpace;
    /** Whether background/post-based input is requested. */
    clickMethod?: 'auto' | 'post' | 'foreground';
}
/** Request for text input. */
export interface TypeTextRequest {
    windowId: WindowId;
    text: string;
    /**
     * Isolation key for the clipboard snapshot taken around the paste; actions
     * from different sessions must not clobber each other's snapshots.
     */
    clipboardKey?: string;
}
/** Request for key chords (e.g. `ctrl+c`). */
export interface PressKeyRequest {
    windowId: WindowId;
    key: string;
}
/** Request for scrolling. */
export interface ScrollRequest {
    windowId: WindowId;
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
    elementId?: ElementId;
    elementIndex?: number;
    coordinateSpace?: CoordinateSpace;
}
/** Request for a drag operation. */
export interface DragRequest {
    windowId: WindowId;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    fromElementId?: ElementId;
    toElementId?: ElementId;
    fromElementIndex?: number;
    toElementIndex?: number;
    coordinateSpace?: CoordinateSpace;
}
/** Request for launching an application. */
export interface LaunchRequest {
    app: string;
    args?: string[];
}
/** Result of launching an application. */
export interface LaunchResult {
    launched: string;
    args: string[];
    forcedNewWindow?: boolean;
    requiresObservation: boolean;
    /** Human-readable list of platform limitations. */
    limitations?: string[];
}
/** Uniform action result returned to the model. */
export interface ActionResult {
    ok: boolean;
    method: string;
    /** Free-form provider-specific details. */
    details?: Record<string, unknown>;
    limitations?: string[];
}
/**
 * A desktop-control provider.
 *
 * Implementations are responsible only for platform primitives. The core
 * wraps them with observation validation, permissions, approval, and error
 * formatting.
 */
export interface DesktopProvider {
    /** Provider metadata and platform info. */
    runtimeInfo(): RuntimeInfo;
    /** What this platform can actually do. */
    capabilities(): Capabilities;
    /** Enumerate desktop windows. */
    listWindows(): Promise<DesktopWindow[]>;
    /** Get a single window by its WindowId. */
    getWindow(id: WindowId): Promise<DesktopWindow>;
    /** Capture a window to `path` (PNG) and return its rect. */
    captureWindow(id: WindowId, path: string): Promise<CaptureResult>;
    /** Bring a window to the foreground. */
    activateWindow(id: WindowId): Promise<void>;
    /** Read the accessibility tree (may be `CAPABILITY_UNAVAILABLE`). */
    accessibilityTree(id: WindowId): Promise<AccessibilitySnapshot>;
    click(request: ClickRequest): Promise<ActionResult>;
    typeText(request: TypeTextRequest): Promise<ActionResult>;
    pressKey(request: PressKeyRequest): Promise<ActionResult>;
    scroll(request: ScrollRequest): Promise<ActionResult>;
    drag(request: DragRequest): Promise<ActionResult>;
    launchApp(request: LaunchRequest): Promise<LaunchResult>;
    /** Snapshot clipboard contents so they can be restored after a paste. */
    saveClipboard(): Promise<boolean>;
    /** Restore a previously saved clipboard snapshot. */
    restoreClipboard(): Promise<boolean>;
    /** Show the control indicator (overlay). */
    startIndicator(target?: WindowId): Promise<void>;
    /** Hide the control indicator. */
    stopIndicator(): Promise<void>;
    /** Optional: refresh the control indicator (e.g. overlay animation pulse). */
    refreshIndicator?(): Promise<void>;
    /**
     * Optional: re-verify that the OS window behind `id` is still the window the
     * observation was created for, immediately before an action. Narrows the
     * validate→operate race on platforms that can detect handle reuse.
     */
    assertIdentity?(id: WindowId, generation?: number): Promise<void>;
    /** Release all native resources. */
    dispose(): Promise<void>;
}
/** Error raised when a capability is completely unavailable. */
export declare function capabilityUnavailable(capability: keyof Capabilities): Error;
/**
 * Every key token that means an OS-level Meta/Super/Hyper modifier, across the
 * Windows, macOS and X11 naming schemes. All press-key filters match against
 * this set (tokens are lowercased before checking): the plain spellings alone
 * let X11 keysym names such as `super_l`/`meta_l`/`hyper_l` reach the native
 * layer and open system UI (Activities, launchers, OS shortcuts).
 */
export declare const META_KEY_TOKENS: ReadonlySet<string>;
/** Convenience: map a CapabilityState to a boolean/unavailable error. */
export declare function assertCapability(state: CapabilityState, capability: keyof Capabilities): void;
