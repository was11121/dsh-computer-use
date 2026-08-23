/**
 * Ambient declarations for the macOS native provider addon
 * (`dsh-computer-use-macos-native`).
 *
 * This file is the contract the future addon must implement. On Windows this
 * module is not loadable; these declarations exist so the TypeScript provider
 * compiles and the native surface is explicit.
 * @module
 */

declare module 'dsh-computer-use-macos-native' {
  export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

  export type WindowIdentity = {
    windowId: string
    title: string
    appName: string
    processId: number
    processPath: string
    className: string
    rect: Rect
    visible: boolean
    minimized: boolean
    onScreen: boolean
    foreground: boolean
    dpi: number
  }

  export type AccessibilityNode = {
    elementId: string
    parent?: string
    role: string
    name: string
    automationId?: string
    rect?: Rect
    enabled: boolean
    visible: boolean
    childCount: number
  }

  export type AccessibilitySnapshot = {
    nodes: AccessibilityNode[]
    checksum: string
    mode: 'full' | 'top-level' | 'platform'
    truncated: boolean
  }

  export function runtimeInfo(): { platform: string; arch: string; node: string; napi: string | undefined }
  export function listWindows(): WindowIdentity[]
  export function getWindow(windowId: string): WindowIdentity
  export function captureWindow(windowId: string, path: string): boolean
  export function activateWindow(windowId: string): boolean
  /** True when the app owning `windowId` is currently the frontmost application. */
  export function isFrontmost(windowId: string): boolean
  export function accessibilityTree(windowId: string, maxNodes: number, maxDepth: number): AccessibilitySnapshot
  export function moveCursor(x: number, y: number): boolean
  export function click(button: 'left' | 'middle' | 'right', count: number): boolean
  export function typeText(text: string): boolean
  export function pressKey(keyCode: number, down: boolean): boolean
  export function scroll(x: number, y: number, deltaX: number, deltaY: number): boolean
  export function drag(fromX: number, fromY: number, toX: number, toY: number): boolean
  export function elementClick(windowId: string, elementId: string, count: number): boolean
  export function elementRect(windowId: string, elementId: string): Rect
  export function saveClipboard(key?: string): boolean
  export function restoreClipboard(key?: string): boolean
  /** Drop every clipboard snapshot without restoring; returns true. */
  export function clearClipboardSnapshots(): boolean
  export function setClipboardText(text: string): boolean
  export function paste(): boolean
  export function overlayCreate(): number
  export function overlayShow(handle: number, windowId: string, text: string): boolean
  export function overlayHide(handle: number, fade?: boolean): boolean
  export function overlayDestroy(handle: number): boolean
  export function restoreSystemCursors(): boolean
}
