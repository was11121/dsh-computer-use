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
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsScope } from '@deepseek-ai/dsh-settings';
import type { ComputerUseConfig } from './config.ts';
/** Loopback RPC channel used by the permission bubble. */
export declare const COMPUTER_USE_RPC_CHANNEL = "/computer-use";
/**
 * Register the loopback RPC channel. Returns a disposer for the plugin's
 * effect lifecycle.
 */
export declare function registerComputerUseRpc(ctx: Context, scope: SettingsScope<ComputerUseConfig>): () => void;
