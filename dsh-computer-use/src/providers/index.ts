/**
 * Provider registry.
 *
 * Exports the platform provider implementations and a tiny factory that selects
 * the current platform's provider. Platform modules are imported lazily inside
 * `createProvider()` because the Windows provider statically imports the
 * win32-only native addon: an eager import would crash plugin loading on
 * macOS/Linux before a single tool runs.
 * @module
 */

import type { DesktopProvider } from '../core/types.ts'

export type { WindowsProvider } from './windows/provider.ts'
export type { MacosProvider } from './macos/provider.ts'
export { createLinuxProvider } from './linux/provider.ts'
export type { X11Provider } from './linux/x11/provider.ts'
export type { WaylandProvider } from './linux/wayland/provider.ts'

/** Create the provider for the current host platform. */
export async function createProvider(): Promise<DesktopProvider> {
  switch (process.platform) {
    case 'win32': {
      const { WindowsProvider } = await import('./windows/provider.ts')
      return new WindowsProvider()
    }
    case 'darwin': {
      const { MacosProvider } = await import('./macos/provider.ts')
      return new MacosProvider()
    }
    case 'linux': {
      const { createLinuxProvider } = await import('./linux/provider.ts')
      return createLinuxProvider()
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
