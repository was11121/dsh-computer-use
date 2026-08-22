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
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { ComputerUseError } from "./core/errors.js";
import { brandProtected as brandProtectedCore } from "./core/protection.js";
import { point as pointCore, validateElementIndex as validateElementIndexCore } from "./core/point.js";
import { resolveWindowId, extractLegacyHwnd } from "./core/identity.js";
import { windowsCapabilities } from "./core/capability.js";
import { guardProvider } from "./core/guard.js";
import { createProvider } from "./providers/index.js";
import { createObservation as createCoreObservation, validateObservation as validateCoreObservation, __clearObservationsForTest, } from "./core/observation.js";
import { runClick, runDrag, runPressKey, runScroll, runTypeText } from "./core/actions.js";
import { META_KEY_TOKENS } from "./core/types.js";
export { ComputerUseError };
const protectedWindows = new Map();
const PROTECTED_WINDOWS_CAP = 512;
const TREE_MAX_NODES = 2000;
const TREE_MAX_DEPTH = 32;
let hooks = null;
let provider = null;
let guarded = null;
let approvalExec;
/** Current observation owner (session/agent), set by the tool layer per call. */
let currentOwner = { sessionId: 'unknown', agentId: 'unknown' };
export function initRuntime(h) {
    hooks = h;
}
/** Attach the executing tool call so approval questions carry the right ids. */
export function setApprovalContext(exec) {
    approvalExec = exec;
}
async function ensureProvider() {
    if (!provider)
        provider = await createProvider();
    return provider;
}
async function approveAction(reason) {
    const h = hooks;
    if (!h)
        return;
    const config = h.getConfig();
    if (!config.requireApproval)
        return;
    // Fail closed: approval is on, so a tool call without an exec context must be
    // denied instead of silently running unapproved desktop input.
    if (approvalExec === undefined || approvalExec.agent === undefined) {
        await stopControlIndicator();
        throw new Error('Approval context is missing; this computer-control action is denied');
    }
    const agent = approvalExec.agent;
    const policy = effectiveApprovalPolicy((agent.session?.events ?? []));
    if (policy === 'never') {
        if (config.skipApprovalWhenPolicyNever)
            return;
        await stopControlIndicator();
        throw new Error('The session approval policy is "never ask", so this computer-control action is denied');
    }
    const outcome = await h.ctx.approval.request({
        agent: agent,
        toolName: approvalExec.name,
        callId: approvalExec.callId,
        reason,
        signal: approvalExec.signal,
    });
    if (outcome !== 'allowed-once') {
        await stopControlIndicator();
        throw new Error('The user rejected this computer-control action');
    }
}
async function ensureGuarded() {
    if (!guarded) {
        const guardHooks = {
            assertAllowed() {
                const config = hooks?.getConfig();
                if (!config?.enabled)
                    throw new Error('计算机控制插件未启用');
                if (!config.allowControl)
                    throw new Error('DSH control permission is off: please enable the "Allow DSH to control the computer" switch next to the chat box');
            },
            // Approval runs exactly once, inside the guard. Screenshot capture and
            // plain activation are deliberately NOT approval-gated (legacy
            // behavior); the interactive gate applies to input/launch actions only.
            approve: async (reason) => {
                if (reason.startsWith('capture window') || reason.startsWith('activate window'))
                    return;
                await approveAction(reason);
            },
        };
        guarded = guardProvider(await ensureProvider(), guardHooks);
    }
    return guarded;
}
/** Owner used for observations/approval; set from the tool exec context. */
export function setObservationOwner(owner) {
    currentOwner = owner;
}
export function observationOwner() {
    return currentOwner;
}
function normalizeWindowId(input) {
    return resolveWindowId(input);
}
function hwndNumber(input) {
    const id = normalizeWindowId(input);
    const value = extractLegacyHwnd(id);
    if (value === undefined)
        throw new ComputerUseError('WINDOW_NOT_FOUND', `Not a Windows HWND: ${id}`, 'REQUIRES_REFRESH');
    return value;
}
// ---------------------------------------------------------------------------
// Window identity / enumeration
// ---------------------------------------------------------------------------
export async function getWindow(id) {
    try {
        return await (await ensureProvider()).getWindow(normalizeWindowId(id));
    }
    catch {
        throw new ComputerUseError('WINDOW_NOT_FOUND', `Window ${id} does not exist`, 'REQUIRES_REFRESH');
    }
}
export async function assertSafeWindow(windowId, action = 'control') {
    const window = await getWindow(windowId);
    const numeric = hwndNumber(windowId);
    const known = protectedWindows.get(numeric);
    if (known || brandProtectedCore(window)) {
        protectedWindows.set(numeric, {
            processId: window.processId,
            processPath: window.processPath,
            title: window.title,
            className: window.className,
        });
        while (protectedWindows.size > PROTECTED_WINDOWS_CAP)
            protectedWindows.delete(protectedWindows.keys().next().value);
        throw new ComputerUseError('PROTECTED_WINDOW', `Operation ${action} on a protected DSH window is forbidden`, 'DENY');
    }
    return window;
}
export async function listWindows() {
    return (await ensureGuarded()).listWindows();
}
/** Windows provider capability report. */
export function capabilities() {
    return windowsCapabilities();
}
async function activateNative(id) {
    const windowId = normalizeWindowId(id);
    await (await ensureGuarded()).activateWindow(windowId);
    const current = await getWindow(windowId);
    if (!current.foreground || !current.visible || current.minimized || !current.onScreen || !current.rect.width || !current.rect.height) {
        throw new ComputerUseError('NATIVE_ACTIVATE_FAILED', 'Target window did not become the foreground visible window', 'RETRY');
    }
    return current;
}
export async function activate(id) {
    await assertSafeWindow(id, 'activate');
    const current = await activateNative(id);
    await showOverlay(id);
    return { activated: true, windowId: id, foreground: current.foreground, rect: current.rect };
}
// ---------------------------------------------------------------------------
// Observation (shared core, session-isolated)
// ---------------------------------------------------------------------------
export async function createObservation(windowId, value) {
    const id = normalizeWindowId(windowId);
    // Capture may restore a minimized target, so persist the post-capture identity.
    const window = await getWindow(id);
    const { windowId: _ignored, ...rest } = value;
    void _ignored;
    return createCoreObservation(window, rest, currentOwner);
}
export async function validateObservation(observationId, windowId, action, options = {}) {
    const id = normalizeWindowId(windowId);
    return validateCoreObservation(observationId, id, await ensureGuarded(), action, {
        requireAccessibilityTree: options.requireAccessibilityTree,
        owner: currentOwner,
    });
}
async function actionObservation(observation, windowId, action, requireAccessibilityTree = false) {
    if (!observation?.observationId) {
        throw new ComputerUseError('INVALID_OBSERVATION', 'Action must use the observationId returned by the latest observation', 'REQUIRES_REFRESH');
    }
    await validateObservation(observation.observationId, windowId, action, { requireAccessibilityTree });
}
export function point(window, x, y, _observation, coordinateSpace = 'auto') {
    return pointCore(window.rect, x, y, coordinateSpace);
}
async function elementPoint(windowId, index) {
    try {
        const tree = await (await ensureProvider()).accessibilityTree(normalizeWindowId(windowId));
        const rect = tree.nodes[index]?.rect;
        if (!rect)
            throw new Error('missing');
        return { x: Math.floor((rect.left + rect.right) / 2), y: Math.floor((rect.top + rect.bottom) / 2) };
    }
    catch {
        throw new ComputerUseError('ELEMENT_NOT_FOUND', `Element index ${index} is stale; please re-observe`, 'REQUIRES_REFRESH');
    }
}
function validateElementIndex(index) {
    validateElementIndexCore(index);
}
const overlay = { timer: undefined, pulseTimer: undefined, visible: false, config: { overlayEnabled: false, overlayIdleMs: 10_000, overlayText: 'DSH 正在操作电脑', overlayColor: '#00D9FF' } };
export function configureOverlay(config) {
    if (overlay.config.overlayEnabled && !config.overlayEnabled)
        void stopControlIndicator();
    overlay.config = config;
}
async function hideOverlayNow(fade = false) {
    void fade;
    if (overlay.timer) {
        clearTimeout(overlay.timer);
        overlay.timer = undefined;
    }
    if (overlay.pulseTimer) {
        clearInterval(overlay.pulseTimer);
        overlay.pulseTimer = undefined;
    }
    if (overlay.visible) {
        try {
            await (await ensureGuarded()).stopIndicator();
        }
        catch { /* best effort */ }
        overlay.visible = false;
    }
}
async function syncOverlay(windowId = 0) {
    if (!overlay.config.overlayEnabled)
        return;
    try {
        if (!overlay.visible) {
            await (await ensureGuarded()).startIndicator(windowId ? normalizeWindowId(windowId) : undefined);
            overlay.visible = true;
        }
        if (overlay.timer)
            clearTimeout(overlay.timer);
        if (overlay.pulseTimer)
            clearInterval(overlay.pulseTimer);
        const native = await ensureProvider();
        const pulse = native.refreshIndicator;
        if (pulse)
            overlay.pulseTimer = setInterval(() => { void pulse().catch(() => undefined); }, 100);
        overlay.timer = setTimeout(() => void hideOverlayNow(true), Math.max(1_000, overlay.config.overlayIdleMs));
    }
    catch { /* overlay is best effort */ }
}
/** Shows the feedback overlay before a tool even asks for approval. */
export function showOverlay(windowId = 0) {
    return syncOverlay(windowId);
}
// ---------------------------------------------------------------------------
// Actions: shared core + guarded provider (single chokepoint)
// ---------------------------------------------------------------------------
export async function capture(windowId, path) {
    await assertSafeWindow(windowId, 'capture');
    const wasVisible = overlay.visible;
    await hideOverlayNow(false);
    try {
        const result = await (await ensureGuarded()).captureWindow(normalizeWindowId(windowId), path);
        return { path: result.path, rect: result.rect };
    }
    finally {
        if (wasVisible)
            await syncOverlay(windowId);
    }
}
export async function click(windowId, x, y, button, count, observation, coordinateSpace = 'auto', options = {}) {
    const id = normalizeWindowId(windowId);
    await actionObservation(observation, id, 'click', options.elementIndex !== undefined);
    await assertSafeWindow(id, 'click');
    if (!['left', 'middle', 'right'].includes(button))
        throw new ComputerUseError('INVALID_CLICK', 'Invalid click arguments', 'DENY');
    if (!Number.isInteger(count) || count < 1 || count > 3)
        throw new ComputerUseError('INVALID_CLICK', 'clickCount must be an integer from 1 to 3', 'DENY');
    let px = x;
    let py = y;
    let space = coordinateSpace;
    if (options.elementIndex !== undefined) {
        validateElementIndex(options.elementIndex);
        const center = await elementPoint(id, options.elementIndex);
        await actionObservation(observation, id, 'click', true);
        px = center.x;
        py = center.y;
        space = 'screen';
    }
    try {
        const result = await runClick({ provider: await ensureGuarded(), observation, owner: currentOwner, action: 'click', windowId: id }, { x: px, y: py, button, count, coordinateSpace: space, clickMethod: options.clickMethod ?? 'auto' });
        await showOverlay(id);
        const details = result.details;
        return { clicked: true, x, y, screenX: details?.x, screenY: details?.y, method: result.method };
    }
    catch (error) {
        // Even a denied/background fallback keeps the takeover indicator honest.
        await showOverlay(id).catch(() => undefined);
        throw error;
    }
}
export async function typeText(windowId, value, observation) {
    const id = normalizeWindowId(windowId);
    await actionObservation(observation, id, 'type');
    await assertSafeWindow(id, 'type');
    if (value.length > 20_000)
        throw new ComputerUseError('INPUT_TOO_LARGE', 'A single input supports at most 20000 characters', 'DENY');
    const result = await runTypeText({ provider: await ensureGuarded(), observation, owner: currentOwner, action: 'type', windowId: id, clipboardKey: `${currentOwner.sessionId}:${currentOwner.agentId}` }, value);
    await showOverlay(id);
    return { typed: true, chars: value.length, method: result.method };
}
// System-level chords that must never be sent even though they do not use the
// Windows/Meta key. Alt+Tab etc. can escape the controlled session.
const FORBIDDEN_CHORDS = [
    { mods: ['alt'], key: 'tab' },
    { mods: ['alt'], key: 'f4' },
    { mods: ['alt'], key: 'esc' },
    { mods: ['alt'], key: 'space' },
    { mods: ['ctrl'], key: 'esc' },
    { mods: ['ctrl', 'shift'], key: 'esc' },
    { mods: ['ctrl', 'alt'], key: 'delete' },
];
function isForbiddenChord(mods, main) {
    return FORBIDDEN_CHORDS.some((c) => c.key === main && c.mods.every((m) => mods.includes(m)));
}
export async function pressKey(windowId, value, observation) {
    const id = normalizeWindowId(windowId);
    await actionObservation(observation, id, 'press key');
    await assertSafeWindow(id, 'press key');
    // Reject meta keys and system chords before anything leaves this process.
    // The shared token set covers X11 keysym aliases (super_l, meta_l, ...) so
    // they cannot reach a helper that resolves raw keysym names.
    const tokens = value.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!tokens.length || tokens.some((x) => META_KEY_TOKENS.has(x))) {
        throw new ComputerUseError('FORBIDDEN_KEY', 'Windows/Meta shortcuts are not allowed', 'DENY');
    }
    const main = tokens.pop();
    if (isForbiddenChord(tokens, main))
        throw new ComputerUseError('FORBIDDEN_KEY', 'System shortcut combinations are not allowed', 'DENY');
    const result = await runPressKey({ provider: await ensureGuarded(), observation, owner: currentOwner, action: 'press key', windowId: id }, value);
    await showOverlay(id);
    return { pressed: true, key: value, modifiers: result.details?.modifiers ?? 0 };
}
export async function scroll(windowId, x, y, scrollX, scrollY, observation, coordinateSpace = 'auto', options = {}) {
    const id = normalizeWindowId(windowId);
    await actionObservation(observation, id, 'scroll', options.elementIndex !== undefined);
    await assertSafeWindow(id, 'scroll');
    if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY))
        throw new ComputerUseError('INVALID_SCROLL', 'Scroll values must be finite numbers', 'DENY');
    const dx = Math.max(-20_000, Math.min(20_000, scrollX));
    const dy = Math.max(-20_000, Math.min(20_000, scrollY));
    let px = x;
    let py = y;
    let space = coordinateSpace;
    if (options.elementIndex !== undefined) {
        validateElementIndex(options.elementIndex);
        const center = await elementPoint(id, options.elementIndex);
        await actionObservation(observation, id, 'scroll', true);
        px = center.x;
        py = center.y;
        space = 'screen';
    }
    const result = await runScroll({ provider: await ensureGuarded(), observation, owner: currentOwner, action: 'scroll', windowId: id }, { x: px, y: py, scrollX: dx, scrollY: dy, coordinateSpace: space });
    await showOverlay(id);
    const details = result.details;
    return { scrolled: true, x, y, scrollX: details?.scrollX ?? dx, scrollY: details?.scrollY ?? dy, method: result.method };
}
export async function drag(windowId, fromX, fromY, toX, toY, observation, coordinateSpace = 'auto', options = {}) {
    const id = normalizeWindowId(windowId);
    await actionObservation(observation, id, 'drag', options.fromElementIndex !== undefined || options.toElementIndex !== undefined);
    await assertSafeWindow(id, 'drag');
    if (options.fromElementIndex !== undefined)
        validateElementIndex(options.fromElementIndex);
    if (options.toElementIndex !== undefined)
        validateElementIndex(options.toElementIndex);
    const a = options.fromElementIndex !== undefined ? await elementPoint(id, options.fromElementIndex) : point(await getWindow(id), fromX, fromY, observation, coordinateSpace);
    const b = options.toElementIndex !== undefined ? await elementPoint(id, options.toElementIndex) : point(await getWindow(id), toX, toY, observation, coordinateSpace);
    if (options.fromElementIndex !== undefined || options.toElementIndex !== undefined) {
        await actionObservation(observation, id, 'drag', true);
    }
    const result = await runDrag({ provider: await ensureGuarded(), observation, owner: currentOwner, action: 'drag', windowId: id }, { fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, coordinateSpace: 'screen' });
    await showOverlay(id);
    return { dragged: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY }, method: result.method };
}
export async function accessibilityTree(windowId) {
    await assertSafeWindow(windowId, 'UIA read');
    void TREE_MAX_NODES;
    void TREE_MAX_DEPTH;
    return (await ensureProvider()).accessibilityTree(normalizeWindowId(windowId));
}
export async function disposeRuntime() {
    __clearObservationsForTest();
    await hideOverlayNow(false);
    if (provider) {
        try {
            await provider.dispose();
        }
        catch { /* best effort */ }
        provider = null;
        guarded = null;
    }
}
export function stopControlSession() {
    void disposeRuntime();
}
export async function stopControlIndicator() {
    await hideOverlayNow(true);
}
export async function launchApp(app, args = []) {
    const { checkLaunchApp } = await import("./core/app-launch.js");
    const { app: safeApp, args: safeArgs } = checkLaunchApp(app, args);
    const result = await (await ensureGuarded()).launchApp({ app: safeApp, args: safeArgs });
    await showOverlay();
    return {
        launched: result.launched,
        args: result.args,
        forcedNewWindow: result.forcedNewWindow ?? false,
        requiresObservation: true,
    };
}
