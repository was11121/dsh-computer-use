import { readFile, mkdir, readdir, lstat, unlink, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DISABLED_MESSAGE } from "./config.js";
import * as desktop from "./runtime.js";
import { resolveWindowId, extractLegacyHwnd } from "./core/identity.js";
function json(value) { return value; }
function textOutput(text) { return [{ type: 'text', text }]; }
/**
 * Accept a legacy numeric HWND or a string `WindowId` at the tool boundary and
 * normalize it to the numeric HWND the Windows provider expects. Non-Windows
 * string ids (mac:..., x11:..., wayland:...) have no legacy HWND and are
 * rejected until those providers ship.
 */
function resolveHwnd(input) {
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input < 0)
            throw new Error('windowId must be an integer');
        return input;
    }
    if (typeof input === 'string') {
        const id = resolveWindowId(input);
        const hwnd = extractLegacyHwnd(id);
        if (hwnd !== undefined)
            return hwnd;
        throw new Error('windowId supports only Windows HWND (a number or win:hWnd: string)');
    }
    throw new Error('windowId must be an integer');
}
/**
 * Screenshot root, canonicalized AFTER creation. The string-level check alone
 * cannot stop a junction/symlink along the route from redirecting writes,
 * attachment reads, or pruning deletes outside the DSH home; the realpath
 * containment check below closes that hole.
 */
async function canonicalHome() {
    const root = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
    try {
        return await realpath(root);
    }
    catch {
        return root;
    }
}
function isOutside(root, target) {
    const rel = relative(root, target);
    return rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel);
}
async function canonicalScreenshotRoot(config) {
    const home = await canonicalHome();
    if (isAbsolute(config.screenshotDir))
        throw new Error('The screenshot directory must be a relative path under the DSH home');
    const target = resolve(home, config.screenshotDir);
    if (isOutside(home, target))
        throw new Error('The screenshot directory must not leave the DSH home');
    await mkdir(target, { recursive: true });
    // Resolve the final path after mkdir: any junction/symlink component would
    // redirect writes/deletes outside DSH home.
    const canonical = await realpath(target);
    if (isOutside(home, canonical))
        throw new Error('The screenshot directory resolves outside the DSH home (junction/symlink)');
    return canonical;
}
let screenshotSequence = 0;
async function screenshotPath(config, windowId) {
    const dir = await canonicalScreenshotRoot(config);
    // Two captures of the same window can land in the same millisecond; a
    // monotonic suffix keeps the files (and their attachment records) distinct.
    return join(dir, `window-${windowId}-${Date.now()}-${screenshotSequence++}.png`);
}
/** Delete screenshots older than the retention window (best effort). No
 * symlink/junction targets are ever followed: links and directories are
 * skipped and every delete target is realpath-checked to stay in the root. */
async function pruneScreenshots(config) {
    const retention = config.screenshotRetention;
    if (!retention || retention <= 0)
        return;
    const dir = await canonicalScreenshotRoot(config);
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return;
    }
    const cutoff = Date.now() - retention;
    for (const name of entries) {
        if (!/^window-.*\.png$/.test(name))
            continue;
        const full = join(dir, name);
        try {
            const st = await lstat(full);
            if (st.isSymbolicLink() || st.isDirectory())
                continue;
            if (st.mtimeMs < cutoff) {
                const resolved = await realpath(full);
                if (isOutside(dir, resolved))
                    continue;
                await unlink(full);
            }
        }
        catch { /* best effort */ }
    }
}
function enabled(config) {
    if (!config.enabled)
        throw new Error(DISABLED_MESSAGE);
    if (process.platform !== 'win32')
        throw new Error('dsh-computer-use is supported on Windows only');
    if (!config.allowControl)
        throw new Error('DSH control permission is off: please enable the "Allow DSH to control the computer" switch next to the chat box');
}
function gate(deps) {
    const config = deps.getConfig();
    try {
        enabled(config);
    }
    catch (error) {
        // Revoking permission also invalidates observations captured under the old
        // authorization state and removes the native takeover indicator.
        desktop.stopControlSession();
        throw error;
    }
    desktop.configureOverlay(config);
}
/**
 * Session/agent scope for observation isolation. Delegated to the runtime so
 * the AsyncLocalStorage call context derives the same scope (see
 * runWithCallContext); kept here only for the legacy bindExec fallback.
 */
function sessionScope(exec) {
    return desktop.sessionScopeOf(exec);
}
/** Bind the executing call to the runtime: approval ids + observation owner. */
function bindExec(exec) {
    desktop.setApprovalContext(exec);
    desktop.setObservationOwner(sessionScope(exec));
}
async function attach(ctx, path) {
    const data = await readFile(path);
    return ctx.attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/png', name: basename(path) });
}
function failure(error) {
    if (error instanceof desktop.ComputerUseError)
        return json(error.toJSON());
    return json({ ok: false, code: 'ACTION_FAILED', recovery: 'RETRY', message: error instanceof Error ? error.message : String(error) });
}
async function action(exec, fn) {
    // Bind the call context for everything fn awaits (observation validation
    // reads the owner, the guard's approval hook reads the exec) so concurrent
    // tool calls from other sessions cannot swap either mid-flight.
    return desktop.runWithCallContext(exec, async () => {
        try {
            return json(await fn());
        }
        catch (error) {
            return failure(error);
        }
    });
}
function actionParams() {
    return { observationId: { type: 'string', required: true, description: '最近一次 computer_get_window_state 返回的 observationId' } };
}
async function validate(args, exec, requireAccessibilityTree = false) {
    const v = args;
    const windowId = resolveHwnd(v.windowId);
    if (typeof v.observationId !== 'string')
        throw new Error('observationId must be a string');
    for (const [name, value] of [['elementIndex', v.elementIndex], ['fromElementIndex', v.fromElementIndex], ['toElementIndex', v.toElementIndex]]) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
            throw new Error(`${name} must be a non-negative integer`);
        }
    }
    if (v.clickCount !== undefined && (typeof v.clickCount !== 'number' || !Number.isInteger(v.clickCount) || v.clickCount < 1 || v.clickCount > 3)) {
        throw new Error('clickCount must be an integer from 1 to 3');
    }
    const observationId = v.observationId;
    return desktop.runWithCallContext(exec, () => desktop.validateObservation(observationId, windowId, 'action', { requireAccessibilityTree }));
}
export function defineListWindowsTool(deps) {
    return defineTool({ name: 'computer_list_apps', description: '列出当前 Windows 桌面窗口。', parameters: {}, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 60_000, isConcurrencySafe: () => false, async execute() { gate(deps); void desktop.showOverlay(); return json({ windows: await desktop.listWindows() }); } });
}
export function defineGetWindowStateTool(deps) {
    return defineTool({ name: 'computer_get_window_state', description: '获取目标窗口的截图（只截该窗口，不泄露其他窗口）和 Windows UI Automation 观察结果。截图左上角是坐标原点；坐标按窗口相对处理，动作必须使用本次返回的 observationId。', parameters: { windowId: { type: 'number', required: true }, includeScreenshot: { type: 'boolean' }, includeText: { type: 'boolean' } }, output: { schema: { type: 'json' }, render: (_a, value) => { const v = value; const blocks = []; if (v.screenshotAttachment !== undefined)
                blocks.push({ type: 'image', attachment: v.screenshotAttachment }); blocks.push({ type: 'text', text: JSON.stringify(value) }); return blocks; } }, timeoutMs: 180_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const id = resolveHwnd(args.windowId);
            return action(exec, async () => {
                const current = await desktop.assertSafeWindow(id, 'observe');
                const state = { ...current };
                if (args.includeScreenshot !== false) {
                    const path = await screenshotPath(deps.getConfig(), id);
                    const capture = await desktop.capture(id, path);
                    state.screenshotPath = capture.path;
                    state.screenshotRect = capture.rect;
                    state.coordinateSpace = 'screenshot';
                    await pruneScreenshots(deps.getConfig());
                }
                if (args.includeText !== false) {
                    const tree = await desktop.accessibilityTree(id);
                    state.accessibilityTree = tree.nodes;
                    state.uiaChecksum = tree.checksum;
                    state.uiaChecksumMode = tree.mode;
                    state.uiaTruncated = tree.truncated;
                }
                const observation = await desktop.runWithCallContext(exec, () => desktop.createObservation(id, state));
                const value = { ...observation };
                if (state.screenshotPath)
                    value.screenshotAttachment = await attach(deps.ctx, state.screenshotPath);
                return value;
            });
        } });
}
export function defineActivateWindowTool(deps) {
    return defineTool({ name: 'computer_activate_window', description: '激活指定窗口。', parameters: { windowId: { type: 'number', required: true } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 60_000, isConcurrencySafe: () => false, async execute(args, exec) { gate(deps); bindExec(exec); const id = resolveHwnd(args.windowId); return action(exec, () => { gate(deps); return desktop.activate(id); }); } });
}
export function defineClickTool(deps) {
    return defineTool({ name: 'computer_click', description: '在最新 observation 对应窗口内点击：传 elementIndex 触发 UIA 元素级点击，或传 x/y 窗口相对坐标点击。', parameters: { windowId: { type: 'number', required: true }, ...actionParams(), elementIndex: { type: 'number', description: 'UI 树中的元素索引（与 x/y 二选一，优先）' }, x: { type: 'number', description: '窗口相对横坐标' }, y: { type: 'number', description: '窗口相对纵坐标' }, coordinateSpace: { type: 'string', enum: ['auto', 'screenshot', 'screen', 'window'], description: '坐标系，默认 auto' }, mouseButton: { type: 'string', enum: ['left', 'middle', 'right'] }, clickCount: { type: 'number' }, clickMethod: { type: 'string', enum: ['auto', 'post'], description: 'auto=前台真实鼠标点击；post=后台消息点击，默认 auto' } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 120_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            const observation = await validate(v, exec, v.elementIndex !== undefined);
            const id = resolveHwnd(v.windowId);
            void desktop.showOverlay(id);
            return action(exec, () => {
                gate(deps);
                const button = v.mouseButton ?? 'left';
                if (!['left', 'middle', 'right'].includes(button))
                    throw new Error('Invalid mouse button');
                const options = {};
                if (v.elementIndex !== undefined)
                    options.elementIndex = v.elementIndex;
                if (v.clickMethod !== undefined)
                    options.clickMethod = v.clickMethod;
                return desktop.click(id, v.x ?? 0, v.y ?? 0, button, v.clickCount ?? 1, observation, v.coordinateSpace ?? 'auto', options);
            });
        } });
}
export function defineTypeTextTool(deps) {
    return defineTool({ name: 'computer_type_text', description: '向最新 observation 对应窗口输入 Unicode 文本。', parameters: { windowId: { type: 'number', required: true }, ...actionParams(), text: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 120_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            const observation = await validate(v, exec);
            const id = resolveHwnd(v.windowId);
            void desktop.showOverlay(id);
            return action(exec, () => { gate(deps); return desktop.typeText(id, v.text, observation); });
        } });
}
export function definePressKeyTool(deps) {
    return defineTool({ name: 'computer_press_key', description: '发送不包含 Windows/Meta 键的按键。', parameters: { windowId: { type: 'number', required: true }, ...actionParams(), key: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 120_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            const observation = await validate(v, exec);
            const id = resolveHwnd(v.windowId);
            void desktop.showOverlay(id);
            return action(exec, () => { gate(deps); return desktop.pressKey(id, v.key, observation); });
        } });
}
export function defineScrollTool(deps) {
    return defineTool({ name: 'computer_scroll', description: '在窗口内滚动：传 elementIndex 则在该元素中心滚动，否则在 x/y 窗口相对坐标处滚动。', parameters: { windowId: { type: 'number', required: true }, ...actionParams(), elementIndex: { type: 'number', description: 'UI 树中的元素索引（与 x/y 二选一，优先）' }, x: { type: 'number', description: '窗口相对横坐标' }, y: { type: 'number', description: '窗口相对纵坐标' }, coordinateSpace: { type: 'string', enum: ['auto', 'screenshot', 'screen', 'window'], description: '坐标系，默认 auto' }, scrollX: { type: 'number' }, scrollY: { type: 'number' } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 120_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            const observation = await validate(v, exec, v.elementIndex !== undefined);
            const id = resolveHwnd(v.windowId);
            void desktop.showOverlay(id);
            return action(exec, () => {
                gate(deps);
                const options = {};
                if (v.elementIndex !== undefined)
                    options.elementIndex = v.elementIndex;
                return desktop.scroll(id, v.x ?? 0, v.y ?? 0, v.scrollX ?? 0, v.scrollY ?? 0, observation, v.coordinateSpace ?? 'auto', options);
            });
        } });
}
export function defineDragTool(deps) {
    return defineTool({ name: 'computer_drag', description: '在窗口内拖动：可用元素索引或窗口相对坐标指定起点/终点。', parameters: { windowId: { type: 'number', required: true }, ...actionParams(), fromElementIndex: { type: 'number', description: '起点元素索引（与 fromX/fromY 二选一，优先）' }, toElementIndex: { type: 'number', description: '终点元素索引（与 toX/toY 二选一，优先）' }, fromX: { type: 'number', description: '起点窗口相对横坐标' }, fromY: { type: 'number', description: '起点窗口相对纵坐标' }, toX: { type: 'number', description: '终点窗口相对横坐标' }, toY: { type: 'number', description: '终点窗口相对纵坐标' }, coordinateSpace: { type: 'string', enum: ['auto', 'screenshot', 'screen', 'window'], description: '坐标系，默认 auto' } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 120_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            const observation = await validate(v, exec, v.fromElementIndex !== undefined || v.toElementIndex !== undefined);
            const id = resolveHwnd(v.windowId);
            void desktop.showOverlay(id);
            return action(exec, () => {
                gate(deps);
                const options = {};
                if (v.fromElementIndex !== undefined)
                    options.fromElementIndex = v.fromElementIndex;
                if (v.toElementIndex !== undefined)
                    options.toElementIndex = v.toElementIndex;
                return desktop.drag(id, v.fromX ?? 0, v.fromY ?? 0, v.toX ?? 0, v.toY ?? 0, observation, v.coordinateSpace ?? 'auto', options);
            });
        } });
}
export function defineLaunchAppTool(deps) {
    return defineTool({ name: 'computer_launch_app', description: '启动应用；启动浏览器时强制 --new-window 保证新开窗口、绝不覆盖 DSH 聊天窗。启动走统一审批门禁；启动成功不代表已经获得可操作窗口，必须重新观察。', parameters: { app: { type: 'string', required: true }, args: { type: 'array', items: { type: 'string' } } }, output: { schema: { type: 'json' }, render: (_a, v) => textOutput(JSON.stringify(v)) }, timeoutMs: 60_000, isConcurrencySafe: () => false, async execute(args, exec) {
            gate(deps);
            bindExec(exec);
            const v = args;
            void desktop.showOverlay();
            return action(exec, () => {
                gate(deps);
                return desktop.launchApp(v.app, Array.isArray(v.args) ? v.args : []);
            });
        } });
}
export function disposeRuntime() { void desktop.disposeRuntime(); }
export function stopControlSession() { desktop.stopControlSession(); }
