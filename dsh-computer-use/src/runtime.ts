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

import type { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { ComputerUseError, type ActionErrorCode } from './core/errors.ts'
import { brandProtected as brandProtectedCore } from './core/protection.ts'
import { point as pointCore, validateElementIndex as validateElementIndexCore } from './core/point.ts'
import { resolveWindowId, extractLegacyHwnd, type WindowId } from './core/identity.ts'
import { windowsCapabilities, type Capabilities } from './core/capability.ts'
import { guardProvider, type GuardHooks } from './core/guard.ts'
import { createProvider } from './providers/index.ts'
import {
  createObservation as createCoreObservation,
  validateObservation as validateCoreObservation,
  __clearObservationsForTest,
  type ObservationOwner,
} from './core/observation.ts'
import { runClick, runDrag, runPressKey, runScroll, runTypeText } from './core/actions.ts'
import type { DesktopProvider, DesktopWindow, Rect } from './core/types.ts'
import { META_KEY_TOKENS } from './core/types.ts'

export { ComputerUseError, type ActionErrorCode, type WindowId }
export type { Rect }
export type { DesktopWindow }
export type AccessibilityNode = import('./core/types.ts').AccessibilityNode

export type WindowState = DesktopWindow & {
  screenshotPath?: string
  screenshotRect?: Rect
  coordinateSpace?: 'screenshot'
  accessibilityTree?: AccessibilityNode[]
  uiaChecksum?: string
  uiaChecksumMode?: 'full' | 'top-level' | 'platform'
  uiaTruncated?: boolean
}
export type Observation = WindowState & {
  observationId: string
  createdAt: number
  expiresAt: number
  sessionId: string
  agentId: string
}

const protectedWindows = new Map<number, { processId: number; processPath: string; title: string; className: string }>()
const PROTECTED_WINDOWS_CAP = 512
const TREE_MAX_NODES = 2000
const TREE_MAX_DEPTH = 32

// ---------------------------------------------------------------------------
// Provider + guard construction (production wiring for createProvider /
// guardProvider / core actions).
// ---------------------------------------------------------------------------
export interface ApprovalExec {
  agent?: unknown
  name: string
  callId: unknown
  signal: AbortSignal
}

interface RuntimeHooks {
  ctx: Context
  getConfig: () => { enabled: boolean; allowControl: boolean; requireApproval: boolean; skipApprovalWhenPolicyNever: boolean }
}

let hooks: RuntimeHooks | null = null
let provider: DesktopProvider | null = null
let guarded: ReturnType<typeof guardProvider> | null = null
let approvalExec: ApprovalExec | undefined

/** Current observation owner (session/agent), set by the tool layer per call. */
let currentOwner: ObservationOwner = { sessionId: 'unknown', agentId: 'unknown' }

/**
 * Per-call execution context (approval exec + observation owner).
 *
 * The old module-level globals were shared across every concurrent tool call:
 * while agent A's action sat in the approval dialog, agent B's call replaced
 * the globals, so A's approval request was filed under B's toolName/callId —
 * the user approved one action and a different one ran. The AsyncLocalStorage
 * binds both to each call's own async chain instead; the globals remain only
 * as a fallback for entry points that never wrapped a call context.
 */
const callContext = new AsyncLocalStorage<{ exec: ApprovalExec; owner: ObservationOwner }>()

export function initRuntime(h: RuntimeHooks): void {
  hooks = h
}

/** Attach the executing tool call so approval questions carry the right ids. */
export function setApprovalContext(exec: ApprovalExec): void {
  approvalExec = exec
}

/**
 * Session/agent scope for observation isolation and approval identity. Read
 * defensively so a missing field degrades to a stable "unknown" scope.
 */
export function sessionScopeOf(exec: ApprovalExec | undefined): ObservationOwner {
  const agent = exec?.agent as { id?: unknown; session?: { id?: unknown; sessionId?: unknown } } | undefined
  const session = agent?.session
  const sessionId =
    typeof session?.id === 'string' ? session.id
    : typeof session?.sessionId === 'string' ? (session.sessionId as string)
    : 'unknown'
  const agentId = typeof agent?.id === 'string' ? agent.id : 'unknown'
  return { sessionId: sessionId || 'unknown', agentId: agentId || 'unknown' }
}

/** Run `fn` with `exec` (and its derived observation owner) bound to the call chain. */
export function runWithCallContext<T>(exec: ApprovalExec, fn: () => Promise<T> | T): Promise<T> | T {
  return callContext.run({ exec, owner: sessionScopeOf(exec) }, fn)
}

/** Internal: the active call context; tests verify chain isolation. */
export function __activeCallContextForTest(): { exec: ApprovalExec; owner: ObservationOwner } | null {
  return callContext.getStore() ?? null
}

function activeExec(): ApprovalExec | undefined {
  return callContext.getStore()?.exec ?? approvalExec
}

function activeOwner(): ObservationOwner {
  return callContext.getStore()?.owner ?? currentOwner
}

async function ensureProvider(): Promise<DesktopProvider> {
  if (!provider) provider = await createProvider()
  return provider
}

async function approveAction(reason: string): Promise<void> {
  const h = hooks
  if (!h) return
  const config = h.getConfig()
  if (!config.requireApproval) return
  // Fail closed: approval is on, so a tool call without an exec context must be
  // denied instead of silently running unapproved desktop input.
  const exec = activeExec()
  if (exec === undefined || exec.agent === undefined) {
    await stopControlIndicator()
    throw new Error('Approval context is missing; this computer-control action is denied')
  }
  const agent = exec.agent as { session?: { events?: readonly unknown[] } }
  const policy = effectiveApprovalPolicy((agent.session?.events ?? []) as never)
  if (policy === 'never') {
    if (config.skipApprovalWhenPolicyNever) return
    await stopControlIndicator()
    throw new Error('The session approval policy is "never ask", so this computer-control action is denied')
  }
  const outcome = await h.ctx.approval.request({
    agent: agent as never,
    toolName: exec.name,
    callId: exec.callId as never,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    await stopControlIndicator()
    throw new Error('The user rejected this computer-control action')
  }
}

async function ensureGuarded(): Promise<ReturnType<typeof guardProvider>> {
  if (!guarded) {
    const guardHooks: GuardHooks = {
      assertAllowed() {
        const config = hooks?.getConfig()
        if (!config?.enabled) throw new Error('计算机控制插件未启用')
        if (!config.allowControl) throw new Error('DSH control permission is off: please enable the "Allow DSH to control the computer" switch next to the chat box')
      },
      // Approval runs exactly once, inside the guard. Screenshot capture is
      // deliberately NOT approval-gated (legacy behavior): providers restore a
      // minimized target through their own inner activateWindow before
      // capturing, which never passes through this guard. The interactive
      // `computer_activate_window` tool DOES pass through here, so raising an
      // arbitrary window to the foreground (a phishing amplifier) asks first.
      approve: async (reason) => {
        if (reason.startsWith('capture window')) return
        await approveAction(reason)
      },
    }
    guarded = guardProvider(await ensureProvider(), guardHooks)
  }
  return guarded
}

/** Owner used for observations/approval; set from the tool exec context. */
export function setObservationOwner(owner: ObservationOwner): void {
  currentOwner = owner
}

export function observationOwner(): ObservationOwner {
  return currentOwner
}

function normalizeWindowId(input: number | WindowId): WindowId {
  return resolveWindowId(input)
}

function hwndNumber(input: number | WindowId): number {
  const id = normalizeWindowId(input)
  const value = extractLegacyHwnd(id)
  if (value === undefined) throw new ComputerUseError('WINDOW_NOT_FOUND', `Not a Windows HWND: ${id}`, 'REQUIRES_REFRESH')
  return value
}

// ---------------------------------------------------------------------------
// Window identity / enumeration
// ---------------------------------------------------------------------------

export async function getWindow(id: number | WindowId): Promise<DesktopWindow> {
  try {
    return await (await ensureProvider()).getWindow(normalizeWindowId(id))
  } catch {
    throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH')
  }
}

export async function assertSafeWindow(windowId: number | WindowId, action = 'control'): Promise<DesktopWindow> {
  const window = await getWindow(windowId)
  const numeric = hwndNumber(windowId)
  const known = protectedWindows.get(numeric)
  if (known || brandProtectedCore(window)) {
    protectedWindows.set(numeric, {
      processId: window.processId,
      processPath: window.processPath,
      title: window.title,
      className: window.className,
    })
    while (protectedWindows.size > PROTECTED_WINDOWS_CAP) protectedWindows.delete(protectedWindows.keys().next().value!)
    throw new ComputerUseError('PROTECTED_WINDOW', `Operation ${action} on a protected DSH window is forbidden`, 'DENY')
  }
  return window
}

export async function listWindows(): Promise<DesktopWindow[]> {
  return (await ensureGuarded()).listWindows()
}

/** Windows provider capability report. */
export function capabilities(): Capabilities {
  return windowsCapabilities()
}

async function activateNative(id: number | WindowId): Promise<DesktopWindow> {
  const windowId = normalizeWindowId(id)
  await (await ensureGuarded()).activateWindow(windowId)
  const current = await getWindow(windowId)
  if (!current.foreground || !current.visible || current.minimized || !current.onScreen || !current.rect.width || !current.rect.height) {
    throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target window did not become the foreground visible window', 'RETRY')
  }
  return current
}

export async function activate(id: number | WindowId): Promise<object> {
  await assertSafeWindow(id, 'activate')
  const current = await activateNative(id)
  await showOverlay(id)
  return { activated: true, windowId: id, foreground: current.foreground, rect: current.rect }
}

// ---------------------------------------------------------------------------
// Observation (shared core, session-isolated)
// ---------------------------------------------------------------------------

export async function createObservation(windowId: number | WindowId, value: WindowState) {
  const id = normalizeWindowId(windowId)
  // Capture may restore a minimized target, so persist the post-capture identity.
  const window = await getWindow(id)
  const { windowId: _ignored, ...rest } = value
  void _ignored
  return createCoreObservation(window, rest, activeOwner())
}

export interface ObservationValidationOptions {
  requireAccessibilityTree?: boolean
}

export async function validateObservation(
  observationId: string,
  windowId: number | WindowId,
  action: string,
  options: ObservationValidationOptions = {},
) {
  const id = normalizeWindowId(windowId)
  return validateCoreObservation(observationId, id, await ensureGuarded(), action, {
    requireAccessibilityTree: options.requireAccessibilityTree,
    owner: activeOwner(),
  })
}

async function actionObservation(
  observation: Observation | undefined,
  windowId: number | WindowId,
  action: string,
  requireAccessibilityTree = false,
): Promise<void> {
  if (!observation?.observationId) {
    throw new ComputerUseError('INVALID_OBSERVATION', 'Action must use the observationId returned by the latest observation', 'REQUIRES_REFRESH')
  }
  await validateObservation(observation.observationId, windowId, action, { requireAccessibilityTree })
}

export type CoordinateSpace = 'auto' | 'screenshot' | 'screen' | 'window'

export function point(window: DesktopWindow, x: number, y: number, _observation?: Observation, coordinateSpace: CoordinateSpace = 'auto'): { x: number; y: number } {
  return pointCore(window.rect, x, y, coordinateSpace)
}

async function elementPoint(windowId: number | WindowId, index: number): Promise<{ x: number; y: number }> {
  try {
    const tree = await (await ensureProvider()).accessibilityTree(normalizeWindowId(windowId))
    const rect = tree.nodes[index]?.rect
    if (!rect) throw new Error('missing')
    return { x: Math.floor((rect.left + rect.right) / 2), y: Math.floor((rect.top + rect.bottom) / 2) }
  } catch {
    throw new ComputerUseError('ELEMENT_NOT_FOUND', `Element index ${index} is stale; please re-observe`, 'REQUIRES_REFRESH')
  }
}

function validateElementIndex(index: number): void {
  validateElementIndexCore(index)
}

// ---------------------------------------------------------------------------
// Overlay (one indicator implementation per platform, via the provider)
// ---------------------------------------------------------------------------
interface OverlayConfig {
  overlayEnabled: boolean
  overlayIdleMs: number
  overlayText: string
  /** Deprecated: the native overlay color is fixed to the DSH brand blue. */
  overlayColor: string
}
const overlay: {
  timer: ReturnType<typeof setTimeout> | undefined
  pulseTimer: ReturnType<typeof setInterval> | undefined
  visible: boolean
  config: OverlayConfig
} = { timer: undefined, pulseTimer: undefined, visible: false, config: { overlayEnabled: false, overlayIdleMs: 10_000, overlayText: 'DSH 正在操作电脑', overlayColor: '#00D9FF' } }

export function configureOverlay(config: OverlayConfig): void {
  if (overlay.config.overlayEnabled && !config.overlayEnabled) void stopControlIndicator()
  overlay.config = config
}

async function hideOverlayNow(fade = false): Promise<void> {
  void fade
  if (overlay.timer) { clearTimeout(overlay.timer); overlay.timer = undefined }
  if (overlay.pulseTimer) { clearInterval(overlay.pulseTimer); overlay.pulseTimer = undefined }
  if (overlay.visible) {
    try { await (await ensureGuarded()).stopIndicator() } catch { /* best effort */ }
    overlay.visible = false
  }
}

async function syncOverlay(windowId: number | WindowId = 0): Promise<void> {
  if (!overlay.config.overlayEnabled) return
  try {
    if (!overlay.visible) {
      await (await ensureGuarded()).startIndicator(windowId ? normalizeWindowId(windowId) : undefined)
      overlay.visible = true
    }
    if (overlay.timer) clearTimeout(overlay.timer)
    if (overlay.pulseTimer) clearInterval(overlay.pulseTimer)
    const native = await ensureProvider()
    // Invoke through the instance: detaching the method (`const pulse = native.refreshIndicator`)
    // ran it with `this === undefined`, so every tick returned a rejected
    // promise that the .catch() below swallowed — the pulse animation never ran.
    const pulse = (): Promise<void> => native.refreshIndicator?.() ?? Promise.resolve()
    if (native.refreshIndicator) {
      overlay.pulseTimer = setInterval(() => { void pulse().catch(() => undefined) }, 100)
    }
    overlay.timer = setTimeout(() => void hideOverlayNow(true), Math.max(1_000, overlay.config.overlayIdleMs))
  } catch { /* overlay is best effort */ }
}

/** Shows the feedback overlay before a tool even asks for approval. */
export function showOverlay(windowId: number | WindowId = 0): Promise<void> {
  return syncOverlay(windowId)
}

// ---------------------------------------------------------------------------
// Actions: shared core + guarded provider (single chokepoint)
// ---------------------------------------------------------------------------

export async function capture(windowId: number | WindowId, path: string): Promise<{ path: string; rect: Rect }> {
  await assertSafeWindow(windowId, 'capture')
  const wasVisible = overlay.visible
  await hideOverlayNow(false)
  try {
    const result = await (await ensureGuarded()).captureWindow(normalizeWindowId(windowId), path)
    return { path: result.path, rect: result.rect }
  } finally {
    if (wasVisible) await syncOverlay(windowId)
  }
}

export interface ClickOptions {
  elementIndex?: number
  clickMethod?: 'auto' | 'post'
}

export async function click(
  windowId: number | WindowId,
  x: number,
  y: number,
  button: 'left' | 'middle' | 'right',
  count: number,
  observation?: Observation,
  coordinateSpace: CoordinateSpace = 'auto',
  options: ClickOptions = {},
): Promise<object> {
  const id = normalizeWindowId(windowId)
  await actionObservation(observation, id, 'click', options.elementIndex !== undefined)
  await assertSafeWindow(id, 'click')
  if (!['left', 'middle', 'right'].includes(button)) throw new ComputerUseError('INVALID_CLICK', 'Invalid click arguments', 'DENY')
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new ComputerUseError('INVALID_CLICK', 'clickCount must be an integer from 1 to 3', 'DENY')
  let px = x
  let py = y
  let space = coordinateSpace
  if (options.elementIndex !== undefined) {
    validateElementIndex(options.elementIndex)
    const center = await elementPoint(id, options.elementIndex)
    await actionObservation(observation, id, 'click', true)
    px = center.x
    py = center.y
    space = 'screen'
  }
  try {
    const result = await runClick(
      { provider: await ensureGuarded(), observation, owner: activeOwner(), action: 'click', windowId: id },
      { x: px, y: py, button, count, coordinateSpace: space, clickMethod: options.clickMethod ?? 'auto' },
    )
    await showOverlay(id)
    const details = (result as { details?: Record<string, unknown> }).details
    return { clicked: true, x, y, screenX: details?.x, screenY: details?.y, method: result.method }
  } catch (error) {
    // Even a denied/background fallback keeps the takeover indicator honest.
    await showOverlay(id).catch(() => undefined)
    throw error
  }
}

export async function typeText(windowId: number | WindowId, value: string, observation?: Observation): Promise<object> {
  const id = normalizeWindowId(windowId)
  await actionObservation(observation, id, 'type')
  await assertSafeWindow(id, 'type')
  if (value.length > 20_000) throw new ComputerUseError('INPUT_TOO_LARGE', 'A single input supports at most 20000 characters', 'DENY')
  const owner = activeOwner()
  const result = await runTypeText(
    { provider: await ensureGuarded(), observation, owner, action: 'type', windowId: id, clipboardKey: `${owner.sessionId}:${owner.agentId}` },
    value,
  )
  await showOverlay(id)
  return { typed: true, chars: value.length, method: result.method }
}

// System-level chords that must never be sent even though they do not use the
// Windows/Meta key. Alt+Tab etc. can escape the controlled session.
const FORBIDDEN_CHORDS: { mods: string[]; key: string }[] = [
  { mods: ['alt'], key: 'tab' },
  { mods: ['alt'], key: 'f4' },
  { mods: ['alt'], key: 'esc' },
  { mods: ['alt'], key: 'space' },
  { mods: ['ctrl'], key: 'esc' },
  { mods: ['ctrl', 'shift'], key: 'esc' },
  { mods: ['ctrl', 'alt'], key: 'delete' },
]
function isForbiddenChord(mods: string[], main: string): boolean {
  return FORBIDDEN_CHORDS.some((c) => c.key === main && c.mods.every((m) => mods.includes(m)))
}
// Main keys that leak beyond the target window even without modifiers:
// PrintScreen copies the whole multi-monitor desktop into the shared clipboard,
// which breaks this plugin's window-isolated capture promise.
const FORBIDDEN_MAIN_KEYS = new Set(['printscreen'])
export async function pressKey(windowId: number | WindowId, value: string, observation?: Observation): Promise<object> {
  const id = normalizeWindowId(windowId)
  await actionObservation(observation, id, 'press key')
  await assertSafeWindow(id, 'press key')
  // Reject meta keys and system chords before anything leaves this process.
  // The shared token set covers X11 keysym aliases (super_l, meta_l, ...) so
  // they cannot reach a helper that resolves raw keysym names.
  const tokens = value.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean)
  if (!tokens.length || tokens.some((x) => META_KEY_TOKENS.has(x))) {
    throw new ComputerUseError('FORBIDDEN_KEY', 'Windows/Meta shortcuts are not allowed', 'DENY')
  }
  const main = tokens.pop()!
  if (isForbiddenChord(tokens, main)) throw new ComputerUseError('FORBIDDEN_KEY', 'System shortcut combinations are not allowed', 'DENY')
  if (FORBIDDEN_MAIN_KEYS.has(main)) throw new ComputerUseError('FORBIDDEN_KEY', 'Full-screen capture keys are not allowed', 'DENY')
  const result = await runPressKey(
    { provider: await ensureGuarded(), observation, owner: activeOwner(), action: 'press key', windowId: id },
    value,
  )
  await showOverlay(id)
  return { pressed: true, key: value, modifiers: (result.details as { modifiers?: number } | undefined)?.modifiers ?? 0 }
}

export interface ScrollOptions { elementIndex?: number }

export async function scroll(
  windowId: number | WindowId,
  x: number,
  y: number,
  scrollX: number,
  scrollY: number,
  observation?: Observation,
  coordinateSpace: CoordinateSpace = 'auto',
  options: ScrollOptions = {},
): Promise<object> {
  const id = normalizeWindowId(windowId)
  await actionObservation(observation, id, 'scroll', options.elementIndex !== undefined)
  await assertSafeWindow(id, 'scroll')
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) throw new ComputerUseError('INVALID_SCROLL', 'Scroll values must be finite numbers', 'DENY')
  const dx = Math.max(-20_000, Math.min(20_000, scrollX))
  const dy = Math.max(-20_000, Math.min(20_000, scrollY))
  let px = x
  let py = y
  let space = coordinateSpace
  if (options.elementIndex !== undefined) {
    validateElementIndex(options.elementIndex)
    const center = await elementPoint(id, options.elementIndex)
    await actionObservation(observation, id, 'scroll', true)
    px = center.x
    py = center.y
    space = 'screen'
  }
  const result = await runScroll(
    { provider: await ensureGuarded(), observation, owner: activeOwner(), action: 'scroll', windowId: id },
    { x: px, y: py, scrollX: dx, scrollY: dy, coordinateSpace: space },
  )
  await showOverlay(id)
  const details = (result as { details?: Record<string, unknown> }).details
  return { scrolled: true, x, y, scrollX: details?.scrollX ?? dx, scrollY: details?.scrollY ?? dy, method: result.method }
}

export interface DragOptions {
  fromElementIndex?: number
  toElementIndex?: number
}

export async function drag(
  windowId: number | WindowId,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  observation?: Observation,
  coordinateSpace: CoordinateSpace = 'auto',
  options: DragOptions = {},
): Promise<object> {
  const id = normalizeWindowId(windowId)
  await actionObservation(observation, id, 'drag', options.fromElementIndex !== undefined || options.toElementIndex !== undefined)
  await assertSafeWindow(id, 'drag')
  if (options.fromElementIndex !== undefined) validateElementIndex(options.fromElementIndex)
  if (options.toElementIndex !== undefined) validateElementIndex(options.toElementIndex)
  const a = options.fromElementIndex !== undefined ? await elementPoint(id, options.fromElementIndex) : point(await getWindow(id), fromX, fromY, observation, coordinateSpace)
  const b = options.toElementIndex !== undefined ? await elementPoint(id, options.toElementIndex) : point(await getWindow(id), toX, toY, observation, coordinateSpace)
  if (options.fromElementIndex !== undefined || options.toElementIndex !== undefined) {
    await actionObservation(observation, id, 'drag', true)
  }
  const result = await runDrag(
    { provider: await ensureGuarded(), observation, owner: activeOwner(), action: 'drag', windowId: id },
    { fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, coordinateSpace: 'screen' },
  )
  await showOverlay(id)
  return { dragged: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, method: result.method }
}

export async function accessibilityTree(windowId: number | WindowId): Promise<{ nodes: AccessibilityNode[]; checksum: string; mode: 'full' | 'top-level' | 'platform'; truncated: boolean }> {
  await assertSafeWindow(windowId, 'UIA read')
  void TREE_MAX_NODES
  void TREE_MAX_DEPTH
  return (await ensureProvider()).accessibilityTree(normalizeWindowId(windowId))
}

export async function disposeRuntime(): Promise<void> {
  __clearObservationsForTest()
  await hideOverlayNow(false)
  if (provider) {
    try { await provider.dispose() } catch { /* best effort */ }
    provider = null
    guarded = null
  }
}

export function stopControlSession(): void {
  void disposeRuntime()
}

export async function stopControlIndicator(): Promise<void> {
  await hideOverlayNow(true)
}

export async function launchApp(app: unknown, args: readonly unknown[] = []): Promise<object> {
  const { checkLaunchApp } = await import('./core/app-launch.ts')
  const { app: safeApp, args: safeArgs } = checkLaunchApp(app, args)
  const result = await (await ensureGuarded()).launchApp({ app: safeApp, args: safeArgs })
  await showOverlay()
  return {
    launched: result.launched,
    args: result.args,
    forcedNewWindow: result.forcedNewWindow ?? false,
    requiresObservation: true,
  }
}

export type { ObservationOwner } from './core/observation.ts'