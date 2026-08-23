/**
 * Platform-neutral provider contract.
 *
 * This is the shared `DesktopProvider` interface that Windows, macOS and Linux
 * providers implement. The core owns observation/approval/permission logic;
 * each provider owns only platform primitives.
 *
 * Phase 1 extraction: the Windows provider is the first implementation.
 * @module
 */
/** Error raised when a capability is completely unavailable. */
export function capabilityUnavailable(capability) {
    return new Error(`CAPABILITY_UNAVAILABLE: ${capability}`);
}
/**
 * Every key token that means an OS-level Meta/Super/Hyper modifier, across the
 * Windows, macOS and X11 naming schemes. All press-key filters match against
 * this set (tokens are lowercased before checking): the plain spellings alone
 * let X11 keysym names such as `super_l`/`meta_l`/`hyper_l` reach the native
 * layer and open system UI (Activities, launchers, OS shortcuts).
 */
export const META_KEY_TOKENS = new Set([
    // Generic / Windows / macOS spellings
    'win', 'windows', 'meta', 'cmd', 'command', 'super', 'os',
    // Windows VK-style names
    'lwin', 'rwin', 'leftwin', 'rightwin', 'leftwindows', 'rightwindows',
    // X11 keysym names (xdotool-style, lowercased)
    'super_l', 'super_r', 'meta_l', 'meta_r',
    'leftmeta', 'rightmeta', 'leftsuper', 'rightsuper',
    'lmeta', 'rmeta',
    'hyper', 'hyper_l', 'hyper_r',
    // Defensive aliases seen in model output / other key naming schemes: not
    // real keysyms everywhere, but blocking them costs nothing and keeps every
    // provider's filter in lockstep with this shared set.
    'win_l', 'win_r', 'os_l', 'os_r', 'leftos', 'rightos', 'loption', 'roption',
]);
/** Convenience: map a CapabilityState to a boolean/unavailable error. */
export function assertCapability(state, capability) {
    if (state === false)
        throw capabilityUnavailable(capability);
}
