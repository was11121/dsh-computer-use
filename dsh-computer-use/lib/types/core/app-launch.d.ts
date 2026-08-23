/**
 * Launch-request hardening shared by the tool entry and every provider.
 *
 * The blacklist is defense-in-depth, NOT an isolation boundary: launching an
 * arbitrary application with arbitrary arguments is inherently powerful. Every
 * launch path MUST therefore also pass the user approval gate (see guard.ts).
 * These checks close the concrete bypasses found in review: separator
 * confusion (`C:\Windows\System32\cmd.exe` passed the old `/`-only split),
 * missing macOS/Linux block lists, control characters, and path traversal.
 * They also block execution vehicles that take a command from argv
 * (`env bash -c ...`, `nohup`, `timeout`, `xargs`, `find -exec`, `awk`,
 * `git ext:`, `ssh ProxyCommand=`, `wsl bash -c`, `schtasks /tr`,
 * `explorer.exe evil.lnk`, ...), versioned interpreter stems (`python3.13`,
 * `pythonw`, `pypy3`), and shell-executed document types (`.desktop`,
 * `.command`, `.scpt`, `.jnlp`, `.settingcontent-ms`).
 * @module
 */
export interface AppLaunch {
    app: string;
    args: string[];
}
/**
 * Validate and normalize a launch request. Throws `UNSAFE_APP` (DENY) when the
 * application is blocked, contains path traversal, or carries control chars.
 */
export declare function checkLaunchApp(app: unknown, args?: readonly unknown[]): AppLaunch;
