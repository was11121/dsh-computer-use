/**
 * `/computer-use` RPC channel (loopback): lets the DSH web bubble read and
 * toggle the desktop-control permission (`allowControl`) without relying on
 * the Host api-proxy settings allowlist — third-party namespaces are not
 * exposed to the browser by default, so the bubble must ride its own channel.
 *
 * Trust boundary: `authority: 'loopback'` only filters at the HTTP fence
 * (loopback Host header, no cross-site fetch metadata). Scripts inside the
 * DSH web realm (every installed client plugin shares one window) and any
 * local process can still reach this channel, so every flip of the master
 * control switch is validated strictly and written to the log for audit.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ComputerUseConfig } from './config.ts'
import { stopControlSession } from './runtime.ts'

/** Loopback RPC channel used by the permission bubble. */
export const COMPUTER_USE_RPC_CHANNEL = '/computer-use'

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

/** Local catch-all error branch (avoids a runtime import from dsh-host-apiproxy). */
function rpcError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/**
 * Minimum spacing between two APPLIED flips of the master switch. The switch
 * writes settings and tears down the control session on every change, so a
 * script in the web realm hammering the endpoint would otherwise churn the
 * engine; human clicks through the permission panel can never be this fast.
 */
const FLIP_MIN_INTERVAL_MS = 300

/**
 * Register the loopback RPC channel. Returns a disposer for the plugin's
 * effect lifecycle.
 */
export function registerComputerUseRpc(
  ctx: Context,
  scope: SettingsScope<ComputerUseConfig>,
): () => void {
  let lastFlipAt = 0
  const handle = ctx.connection.rpc.handle(
    COMPUTER_USE_RPC_CHANNEL,
    async (endpoint, payload) => {
      try {
        switch (endpoint) {
          case 'allowControl/get': {
            // 读取当前授权状态（默认未授权）。
            return ok({ allowed: scope.get().allowControl === true })
          }
          case 'allowControl/set': {
            // 写入授权状态；载荷必须是显式布尔值，只有显式 true 才算授权。
            const value = (payload ?? {}) as { allowed?: unknown }
            if (typeof value.allowed !== 'boolean') {
              return rpcError(new Error('allowControl/set requires a boolean "allowed" field'))
            }
            const allowed = value.allowed
            const changed = scope.get().allowControl !== allowed
            if (changed) {
              if (Date.now() - lastFlipAt < FLIP_MIN_INTERVAL_MS) {
                return rpcError(new Error('The control permission is being changed too quickly; please retry'))
              }
              // 审计轨迹：这是桌面控制的总开关，翻转必须留痕。
              ctx.logger.info(`[computer-use] allowControl changed to ${allowed}`)
              lastFlipAt = Date.now()
              await scope.update({ allowControl: allowed })
              stopControlSession()
            }
            return ok({ allowed: scope.get().allowControl === true })
          }
          default: {
            return rpcError(new Error(`DSH Computer Use RPC 未知端点: ${endpoint}`))
          }
        }
      } catch (error) {
        return rpcError(error)
      }
    },
    { authority: 'loopback' },
  )
  return () => { void handle() }
}
