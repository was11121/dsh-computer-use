/**
 * Cross-platform window/element identity.
 *
 * HWND numeric ids are Windows-specific. As the plugin grows a macOS/Linux
 * provider we need a string `WindowId`/`ElementId` scheme. Windows keeps
 * accepting the legacy numeric HWND by wrapping it in a `win:hWnd:<hex>`
 * string while the native layer continues to operate on the raw HWND.
 * @module
 */

/** Stable cross-platform window identifier (opaque string). */
export type WindowId = string

/** Stable cross-platform element identifier (opaque string). */
export type ElementId = string

/** Parsed components of a `WindowId` string. */
export interface ParsedWindowId {
  /** Platform tag: `win`, `mac`, `x11`, `wayland`. */
  platform: string
  /** Backend-specific payload. */
  raw: string
}

const HWND_PREFIX = 'win:hWnd:'

/** Resolve a legacy numeric HWND (or existing string) into a stable WindowId. */
export function resolveWindowId(input: number | string): WindowId {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0) {
      throw new TypeError(`Invalid window id: ${input}`)
    }
    return `${HWND_PREFIX}${input.toString(16).padStart(16, '0')}`
  }
  return input
}

/** Parse a WindowId into platform + raw payload; non-parsable returns null. */
export function parseWindowId(id: WindowId): ParsedWindowId | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  return { platform: id.slice(0, idx), raw: id.slice(idx + 1) }
}

/** Extract the legacy Windows HWND from a WindowId; undefined when not Windows. */
export function extractLegacyHwnd(id: WindowId): number | undefined {
  if (!id.startsWith(HWND_PREFIX)) return undefined
  const raw = id.slice(HWND_PREFIX.length)
  // A HWND fits in 16 hex digits (64 bits); anything longer parses to a
  // non-integral double that would silently truncate inside the native layer.
  if (raw.length > 16 || !/^[0-9a-fA-F]+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 16)
  // Even within 64 bits, values above 2^53 lose precision as JS numbers and
  // would arrive at the native layer as a different handle than observed.
  if (!Number.isSafeInteger(value)) return undefined
  return value
}
