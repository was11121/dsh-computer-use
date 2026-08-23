import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.dirname(fileURLToPath(import.meta.url))
let native
try {
  native = require('node-gyp-build')(root)
} catch (error) {
  const code = process.platform !== 'win32' ? 'NATIVE_PROVIDER_PLATFORM_UNSUPPORTED' :
    process.arch !== 'x64' ? 'NATIVE_PROVIDER_ARCH_UNSUPPORTED' : 'NATIVE_PROVIDER_LOAD_FAILED'
  const wrapped = new Error(`${code}: 无法加载 dsh-computer-use-native。请确认已安装 Windows x64 prebuild 或 Visual C++ Runtime。`, { cause: error })
  wrapped.code = code
  throw wrapped
}

export const runtimeInfo = () => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  napi: process.versions.napi,
})
export const listWindows = native.listWindows
export const getWindow = native.getWindow
export const verifyWindow = native.verifyWindow
export const captureWindow = native.captureWindow
export const activateWindow = native.activateWindow
export const invokeAtPoint = native.invokeAtPoint
export const elementClick = native.elementClick
export const elementRect = native.elementRect
export const moveCursor = native.moveCursor
export const click = native.click
export const typeText = native.typeText
export const pressKey = native.pressKey
export const scroll = native.scroll
export const drag = native.drag
export const postClick = native.postClick
export const postWheel = native.postWheel
// NOTE: postChar, getClipboardText, screenRect and captureScreen were removed
// in the 2026-08 audit — they were never used by the provider layer and each
// exported a capability the plugin never exposes on purpose.
// Clipboard snapshots are keyed by session owner so concurrent or cross-session
// paste flows never restore the wrong content.
export const saveClipboard = (key) => native.saveClipboard(typeof key === 'string' ? key : 'default')
export const restoreClipboard = (key) => native.restoreClipboard(typeof key === 'string' ? key : 'default')
// Drop all snapshots without restoring: teardown path so dead sessions cannot
// pin their captured clipboard IDataObject (bounded leak guard).
export const clearClipboardSnapshots = () => native.clearClipboardSnapshots()
export const setClipboardText = native.setClipboardText
export const paste = native.paste
export const accessibilityTree = native.accessibilityTree
export const overlayCreate = native.overlayCreate
export const overlayShow = native.overlayShow
export const overlayRefresh = native.overlayRefresh
export const overlayHide = native.overlayHide
export const overlayDestroy = native.overlayDestroy
export const restoreSystemCursors = native.restoreSystemCursors
