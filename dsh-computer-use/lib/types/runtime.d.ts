/**
 * Production runtime facade.
 *
 * The tools call into this module; it owns the SINGLE protected entry into
 * desktop control:
 *
 *   tools -> runtime -> GuardedDesktopProvider (core/guard) -> platform
 *   provider (createProvider, e.g. WindowsProvider) -> native addon
 *
 * Observation validation and action execution go through the shared core
 * (`core/observation.ts` / `core/actions.ts`), so every future platform
 * provider built on `createProvider()` is protected by the same permission,
 * approval, session-isolation and TOCTOU gates without per-platform code.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import { ComputerUseError, type ActionErrorCode } from './core/errors.ts';
import { type WindowId } from './core/identity.ts';
import { type Capabilities } from './core/capability.ts';
import { type ObservationOwner } from './core/observation.ts';
import type { DesktopWindow, Rect } from './core/types.ts';
export { ComputerUseError, type ActionErrorCode, type WindowId };
export type { Rect };
export type { DesktopWindow };
export type AccessibilityNode = import('./core/types.ts').AccessibilityNode;
export type WindowState = DesktopWindow & {
    screenshotPath?: string;
    screenshotRect?: Rect;
    coordinateSpace?: 'screenshot';
    accessibilityTree?: AccessibilityNode[];
    uiaChecksum?: string;
    uiaChecksumMode?: 'full' | 'top-level' | 'platform';
    uiaTruncated?: boolean;
};
export type Observation = WindowState & {
    observationId: string;
    createdAt: number;
    expiresAt: number;
    sessionId: string;
    agentId: string;
};
export interface ApprovalExec {
    agent?: unknown;
    name: string;
    callId: unknown;
    signal: AbortSignal;
}
interface RuntimeHooks {
    ctx: Context;
    getConfig: () => {
        enabled: boolean;
        allowControl: boolean;
        requireApproval: boolean;
        skipApprovalWhenPolicyNever: boolean;
    };
}
export declare function initRuntime(h: RuntimeHooks): void;
/** Attach the executing tool call so approval questions carry the right ids. */
export declare function setApprovalContext(exec: ApprovalExec): void;
/**
 * Session/agent scope for observation isolation and approval identity. Read
 * defensively so a missing field degrades to a stable "unknown" scope.
 */
export declare function sessionScopeOf(exec: ApprovalExec | undefined): ObservationOwner;
/** Run `fn` with `exec` (and its derived observation owner) bound to the call chain. */
export declare function runWithCallContext<T>(exec: ApprovalExec, fn: () => Promise<T> | T): Promise<T> | T;
/** Internal: the active call context; tests verify chain isolation. */
export declare function __activeCallContextForTest(): {
    exec: ApprovalExec;
    owner: ObservationOwner;
} | null;
/** Owner used for observations/approval; set from the tool exec context. */
export declare function setObservationOwner(owner: ObservationOwner): void;
export declare function observationOwner(): ObservationOwner;
export declare function getWindow(id: number | WindowId): Promise<DesktopWindow>;
export declare function assertSafeWindow(windowId: number | WindowId, action?: string): Promise<DesktopWindow>;
export declare function listWindows(): Promise<DesktopWindow[]>;
/** Windows provider capability report. */
export declare function capabilities(): Capabilities;
export declare function activate(id: number | WindowId): Promise<object>;
export declare function createObservation(windowId: number | WindowId, value: WindowState): Promise<import("./core/observation.ts").Observation>;
export interface ObservationValidationOptions {
    requireAccessibilityTree?: boolean;
}
export declare function validateObservation(observationId: string, windowId: number | WindowId, action: string, options?: ObservationValidationOptions): Promise<import("./core/observation.ts").Observation>;
export type CoordinateSpace = 'auto' | 'screenshot' | 'screen' | 'window';
export declare function point(window: DesktopWindow, x: number, y: number, _observation?: Observation, coordinateSpace?: CoordinateSpace): {
    x: number;
    y: number;
};
interface OverlayConfig {
    overlayEnabled: boolean;
    overlayIdleMs: number;
    overlayText: string;
    /** Deprecated: the native overlay color is fixed to the DSH brand blue. */
    overlayColor: string;
}
export declare function configureOverlay(config: OverlayConfig): void;
/** Shows the feedback overlay before a tool even asks for approval. */
export declare function showOverlay(windowId?: number | WindowId): Promise<void>;
export declare function capture(windowId: number | WindowId, path: string): Promise<{
    path: string;
    rect: Rect;
}>;
export interface ClickOptions {
    elementIndex?: number;
    clickMethod?: 'auto' | 'post';
}
export declare function click(windowId: number | WindowId, x: number, y: number, button: 'left' | 'middle' | 'right', count: number, observation?: Observation, coordinateSpace?: CoordinateSpace, options?: ClickOptions): Promise<object>;
export declare function typeText(windowId: number | WindowId, value: string, observation?: Observation): Promise<object>;
export declare function pressKey(windowId: number | WindowId, value: string, observation?: Observation): Promise<object>;
export interface ScrollOptions {
    elementIndex?: number;
}
export declare function scroll(windowId: number | WindowId, x: number, y: number, scrollX: number, scrollY: number, observation?: Observation, coordinateSpace?: CoordinateSpace, options?: ScrollOptions): Promise<object>;
export interface DragOptions {
    fromElementIndex?: number;
    toElementIndex?: number;
}
export declare function drag(windowId: number | WindowId, fromX: number, fromY: number, toX: number, toY: number, observation?: Observation, coordinateSpace?: CoordinateSpace, options?: DragOptions): Promise<object>;
export declare function accessibilityTree(windowId: number | WindowId): Promise<{
    nodes: AccessibilityNode[];
    checksum: string;
    mode: 'full' | 'top-level' | 'platform';
    truncated: boolean;
}>;
export declare function disposeRuntime(): Promise<void>;
export declare function stopControlSession(): void;
export declare function stopControlIndicator(): Promise<void>;
export declare function launchApp(app: unknown, args?: readonly unknown[]): Promise<object>;
export type { ObservationOwner } from './core/observation.ts';
