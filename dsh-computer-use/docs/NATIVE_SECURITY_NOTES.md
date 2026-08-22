# Native provider (provider.cc) security notes

Findings from the 2026-08 source audit that live in the C++ layer and can only
land with a native rebuild (`npm --prefix native run build`, requires the MSVC
toolchain; the runtime loads the prebuilt `native/build/Release/*.node`).

## Should fix at the next native build

1. **Clipboard snapshot map is unbounded** (`clipboardSnapshots`, ~line 299).
   Snapshots are keyed by `session:agent`; an entry holds an `IDataObject`
   (and possibly a `CoUninitialize` obligation). Restore is attempted in a
   `finally` on the JS side, but a crashed session or a failed restore leaves
   the entry alive forever. Over weeks of sessions this leaks COM objects.
   Suggested: cap the map (evict oldest beyond ~64 entries) and/or export a
   `clearClipboardSnapshots()` that the provider's `dispose()` calls.

2. **`TypeText` paces at `Sleep(10)` per char and blocks the JS event loop**
   (~line 274). With the runtime's 20 000-char cap this froze the engine for
   up to 200 s, and tool timeouts could not fire because timers cannot run
   while a native call blocks. Mitigated in JS: the Windows and macOS
   providers now cap the SendInput fallback at 1 000 chars (~10 s worst
   case). A native-side fix (chunked/async injection, or a shorter pace)
   removes the freeze entirely.

3. **`PostChar` paces at `Sleep(8)` per char with no length cap** (~line 426).
   It is exported through `native/index.mjs` but never called by the provider
   layer today. If it ever becomes reachable from a tool, give it the same
   1 000-char guard or remove the export.

## Reviewed and acceptable (no change needed)

- `Capture` writes the PNG to a path supplied by the TS layer; the TS
  chokepoint (`lib/tools.ts` screenshot-root canonicalization + realpath
  containment) is the validation point. Native trusts its caller by design.
- `cursorFilePath()` writes `dsh-control-cursor-v4.cur` to `%TEMP%` with
  `CREATE_ALWAYS` (pre-placement cannot survive the overwrite) and %TEMP% is
  per-user ACL'd.
- `Paste` (Ctrl+V) does not re-verify the foreground window; the provider
  asserts activation immediately before, and the residual race is accepted.
- `elementClick` / `invokeAtPoint` invoke UIA patterns without activation —
  background invoke is by design and approval-gated in the TS layer.
- `PostClick`/`PostWheel`/`OverlayHide` contain bounded `Sleep()` calls
  (≤ 3 iterations / 8 fade frames); the JS event loop blocking is brief.
- The HWND generation property (`DSH_CU_WINDOW_GENERATION`) and the FNV-1a
  UIA checksum are sound TOCTOU/staleness guards.

## Linux X11 helper (src/providers/linux/x11/helper.c) — audited 2026-08

- The helper now echoes the request `id` in every response; the Node provider
  matches strictly by id, so the echo is part of the protocol contract.
- `keycode_for_name` refuses every Super/Meta/Hyper spelling and no longer
  accepts raw numeric keycodes (an arbitrary-keycode injection backdoor).
- `method_activate_window` polls `_NET_ACTIVE_WINDOW` (~500 ms) and reports
  `false` when the WM did not actually activate the target — the provider
  fails closed and never injects global input into another window.
- Remaining accepted limitations: `json_field` is a substring scanner (safe
  because the trusted Node caller always emits `id`/`method` first), text is
  ASCII-only (non-ASCII fails with `UNSUPPORTED_TEXT`), AT-SPI/clipboard are
  stubs.

## macOS draft (src/providers/macos/src/provider.mm) — audited 2026-08

- Never compiled on a real Mac (CI builds non-fatally). Fixed during audit:
  duplicate `ownerPid` declaration in `GetWindow` (compile error) and
  `RuntimeInfo` reporting "arm64" on Intel (pointer-size arch guess).
- Same unbounded clipboard snapshot map as the Windows addon
  (`gSavedClipboard`); apply the cap from item 1 when this draft becomes real.
