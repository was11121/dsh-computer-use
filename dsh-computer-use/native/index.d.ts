export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
export type WindowIdentity = { windowId: number; title: string; className: string; appName: string; processId: number; processPath: string; rect: Rect; visible: boolean; minimized: boolean; onScreen: boolean; foreground: boolean; dpi: number; generation: number }
export type AccessibilityNode = { index: number; parent: number; role: number; name: string; automationId: string; rect?: Rect; enabled: boolean; visible: boolean; childCount: number }
export function runtimeInfo(): { platform: string; arch: string; node: string; napi: string | undefined }
export function listWindows(): WindowIdentity[]
export function getWindow(windowId: number): WindowIdentity
/** True when the HWND still exists and (when generation > 0) still carries the observed generation token. */
export function verifyWindow(windowId: number, generation?: number): boolean
export function captureWindow(windowId: number, path: string): boolean
export function activateWindow(windowId: number): boolean
export function invokeAtPoint(windowId: number, x: number, y: number, count: number): boolean
export function elementClick(windowId: number, index: number, count: number, maxNodes?: number, maxDepth?: number): boolean
export function elementRect(windowId: number, index: number, maxNodes?: number, maxDepth?: number): Rect
export function moveCursor(x: number, y: number): boolean
export function click(button: 'left' | 'middle' | 'right', count: number): boolean
export function typeText(text: string): boolean
export function pressKey(keyCode: number, down: boolean): boolean
export function scroll(x: number, y: number, deltaX: number, deltaY: number): boolean
export function drag(fromX: number, fromY: number, toX: number, toY: number): boolean
export function postClick(windowId: number, x: number, y: number, button: 'left' | 'middle' | 'right', count: number): boolean
export function postWheel(windowId: number, x: number, y: number, delta: number, horizontal?: boolean): boolean
export function saveClipboard(key?: string): boolean
export function restoreClipboard(key?: string): boolean
/** Drop every clipboard snapshot without restoring; returns true. */
export function clearClipboardSnapshots(): boolean
export function setClipboardText(text: string): boolean
export function paste(): boolean
export function accessibilityTree(windowId: number, maxNodes: number, maxDepth: number): { nodes: AccessibilityNode[]; truncated: boolean; checksum: string; mode: 'full' | 'top-level' }
export function overlayCreate(): number
export function overlayShow(handle: number, windowId: number, text: string, color?: string): boolean
export function overlayRefresh(handle: number): boolean
export function overlayHide(handle: number, fade?: boolean): boolean
export function overlayDestroy(handle: number): boolean
export function restoreSystemCursors(): boolean
