import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerComputerUseRpc, COMPUTER_USE_RPC_CHANNEL } from '../../src/rpc.ts'
import type { ComputerUseConfig } from '../../src/config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'

type Handler = (endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>

function makeHarness(initial: Partial<ComputerUseConfig> = {}): { handler: Handler; updates: number } {
  let handler: Handler | undefined
  const ctx = {
    connection: {
      rpc: {
        handle: (_channel: string, h: Handler) => {
          handler = h
          return async () => {}
        },
      },
    },
    logger: { info() {} },
  } as unknown as Context
  let config: ComputerUseConfig = {
    enabled: true,
    allowControl: false,
    requireApproval: true,
    skipApprovalWhenPolicyNever: true,
    screenshotDir: 'computer-use/screenshots',
    screenshotRetention: 86_400_000,
    overlayEnabled: true,
    overlayIdleMs: 10_000,
    overlayText: 'DSH 正在操作电脑',
    overlayColor: '#00D9FF',
    ...initial,
  }
  const updates: { count: number } = { count: 0 }
  const scope = {
    get: () => config,
    update: async (patch: Partial<ComputerUseConfig>) => {
      updates.count++
      config = { ...config, ...patch }
    },
  } as unknown as SettingsScope<ComputerUseConfig>
  registerComputerUseRpc(ctx, scope)
  assert.ok(handler, 'rpc handler must be registered')
  return { handler: handler!, updates: updates as { count: number } }
}

test('allowControl/get reports the current state', async () => {
  const { handler } = makeHarness()
  const res = await handler('allowControl/get', {})
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, { allowed: false })
})

test('allowControl/set requires a boolean and applies the change once', async () => {
  const { handler, updates } = makeHarness()
  const bad = await handler('allowControl/set', { allowed: 'yes' })
  assert.equal(bad.ok, false)
  const res = await handler('allowControl/set', { allowed: true })
  assert.equal(res.ok, true)
  assert.deepEqual(res.value, { allowed: true })
  assert.equal(updates.count, 1)
  // A no-op flip (same value) writes nothing.
  const again = await handler('allowControl/set', { allowed: true })
  assert.equal(again.ok, true)
  assert.equal(updates.count, 1)
})

test('rapid allowControl flips are rate-limited (anti churn on settings + session teardown)', async () => {
  const { handler, updates } = makeHarness()
  const first = await handler('allowControl/set', { allowed: true })
  assert.equal(first.ok, true)
  // Immediately flipping back lands inside the re-arm window: rejected, and
  // the state stays as the first flip left it.
  const second = await handler('allowControl/set', { allowed: false })
  assert.equal(second.ok, false)
  assert.match(second.error?.message ?? '', /too quickly/)
  assert.equal(updates.count, 1)
  const state = await handler('allowControl/get', {})
  assert.deepEqual(state.value, { allowed: true })
})

test('unknown endpoints are rejected', async () => {
  const { handler } = makeHarness()
  const res = await handler('allowControl/explode', {})
  assert.equal(res.ok, false)
})
