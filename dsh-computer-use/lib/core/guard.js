/**
 * Guarded provider wrapper.
 *
 * The core cannot force every caller to go through a single chokepoint, but it
 * provides this wrapper as the *official* production entry so host permission,
 * approval and capability gates run before any provider primitive is touched.
 * Use it in the Windows/macOS/Linux package entry points instead of calling a
 * raw `DesktopProvider` directly.
 * @module
 */
import { assertCapability } from "./types.js";
import { ComputerUseError } from "./errors.js";
/** Official guarded entry point for desktop-control providers. */
export class GuardedDesktopProvider {
    inner;
    hooks;
    constructor(inner, hooks) {
        this.inner = inner;
        this.hooks = hooks;
    }
    gate(capability, reason) {
        assertCapability(this.inner.capabilities()[capability], capability);
        this.hooks.assertAllowed();
    }
    async gateAsync(capability, reason) {
        this.gate(capability, reason);
        if (this.hooks.approve)
            await this.hooks.approve(reason);
    }
    runtimeInfo() {
        return this.inner.runtimeInfo();
    }
    capabilities() {
        return this.inner.capabilities();
    }
    async listWindows() {
        this.gate('windowEnumeration', 'list windows');
        return this.inner.listWindows();
    }
    async getWindow(id) {
        this.gate('windowEnumeration', 'get window');
        return this.inner.getWindow(id);
    }
    async captureWindow(id, path) {
        await this.gateAsync('windowCapture', 'capture window');
        return this.inner.captureWindow(id, path);
    }
    async activateWindow(id) {
        await this.gateAsync('windowEnumeration', 'activate window');
        return this.inner.activateWindow(id);
    }
    async accessibilityTree(id) {
        this.gate('accessibilityTree', 'read accessibility tree');
        return this.inner.accessibilityTree(id);
    }
    /**
     * Re-verify the observed window generation right before a primitive runs.
     * Without this delegation the TOCTOU narrowing in `core/actions.ts`
     * (`ctx.provider.assertIdentity`) silently never fires, because the guarded
     * wrapper hid the inner provider's implementation.
     */
    async assertIdentity(id, generation) {
        this.gate('windowEnumeration', 'verify window identity');
        await this.inner.assertIdentity?.(id, generation);
    }
    async click(request) {
        await this.gateAsync('foregroundInput', 'simulate mouse click');
        return this.inner.click(request);
    }
    async typeText(request) {
        await this.gateAsync('foregroundInput', 'type text');
        return this.inner.typeText(request);
    }
    async pressKey(request) {
        await this.gateAsync('foregroundInput', 'send key');
        return this.inner.pressKey(request);
    }
    async scroll(request) {
        await this.gateAsync('foregroundInput', 'scroll');
        return this.inner.scroll(request);
    }
    async drag(request) {
        await this.gateAsync('foregroundInput', 'drag');
        return this.inner.drag(request);
    }
    async launchApp(request) {
        await this.gateAsync('launchApp', `launch application ${request.app}`);
        return this.inner.launchApp(request);
    }
    async saveClipboard() {
        this.gate('clipboard', 'save clipboard');
        return this.inner.saveClipboard();
    }
    async restoreClipboard() {
        this.gate('clipboardRestore', 'restore clipboard');
        return this.inner.restoreClipboard();
    }
    async startIndicator(target) {
        this.gate('overlay', 'show control indicator');
        return this.inner.startIndicator(target);
    }
    async stopIndicator() {
        this.gate('overlay', 'hide control indicator');
        return this.inner.stopIndicator();
    }
    async dispose() {
        await this.inner.dispose();
    }
}
/** Convenience factory. */
export function guardProvider(provider, hooks) {
    return new GuardedDesktopProvider(provider, hooks);
}
/** Error used when a capability is entirely unavailable. */
export function capabilityUnavailableError(capability) {
    return new ComputerUseError('CAPABILITY_UNAVAILABLE', `Capability is not available: ${capability}`, 'NONE');
}
