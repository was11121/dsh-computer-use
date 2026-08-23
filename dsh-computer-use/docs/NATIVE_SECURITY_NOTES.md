# Native provider (provider.cc) security notes

Findings from the 2026-08 source audit that live in the C++ layer and can only
land with a native rebuild (`npm --prefix native run build`, requires the MSVC
toolchain; the runtime loads the prebuilt `native/build/Release/*.node`).

## Fixed in the 2026-08-23 rebuild (round 2)

1. **Window generation tokens are now fully random** (`windowGeneration`).
   The old global counter was predictable, and window properties are
   readable/writable cross-process: a hostile process could enumerate the
   property off live windows, predict the next value and pre-set it after
   HWND reuse, defeating the TOCTOU identity guard. Tokens are now 64-bit
   `std::random_device` values (rand_s/RtlGenRandom on MSVC).

2. **`invokeAtPoint` UIA walk is bounded** (>2000 elements fails closed,
   matching `Uia()`'s order-of-magnitude cap). Browser-scale trees previously
   blocked the JS event loop for seconds through cross-process COM.

3. **Cursor swap survives crashes cleanly**: `setSystemCursors(true)` writes
   `%TEMP%\dsh-cursor-swap.marker`; `Init()` checks the marker and restores
   default cursors (`SPI_SETCURSORS`) if the engine died mid-session.

4. **Overlay window class registers on the addon module**, not the host EXE
   (`GetModuleHandleExW(FROM_ADDRESS)`), so another in-process component can
   no longer pre-register `DSHComputerUseOverlay` with its own wndproc.

5. **Unused dangerous exports removed** (function bodies + export entries):
   `captureScreen` (full-desktop capture to a caller path), `screenRect`,
   `postChar` (unbounded `Sleep(8)`/char), `getClipboardText` (read the whole
   shared clipboard). Same removal applied to the macOS draft
   (`GetClipboardText`). `pressKey`/`Key` stays: the JS layer's VK whitelist
   is its guard, and no Win/Meta VK exists in that whitelist.

## Fixed in the 2026-08-23 rebuild (round 1)

1. **Clipboard snapshot map was unbounded** (`clipboardSnapshots`).
   Snapshots are keyed by `session:agent`; an entry holds an `IDataObject`
   (and possibly a `CoUninitialize` obligation). Restore is attempted in a
   `finally` on the JS side, but a crashed session or a failed restore left
   the entry alive forever. Fixed: the map is capped at 8 entries with
   least-recently-saved eviction, `clearClipboardSnapshots()` is exported,
   and `WindowsProvider.dispose()` calls it on control-session teardown.
   The macOS draft (`gSavedClipboard`) received the same cap + clear export.

2. **UIA checksum now length-prefixes free-form strings** (`name`,
   `automationId`). The old `":"`-separated concatenation was ambiguous: a
   crafted element name containing `:` or `;` could make two different trees
   serialize identically and slip past the "tree unchanged" gate.

## Should fix at the next native build

1. **`TypeText` paces at `Sleep(10)` per char and blocks the JS event loop**
   (~line 274). With the runtime's 20 000-char cap this froze the engine for
   up to 200 s, and tool timeouts could not fire because timers cannot run
   while a native call blocks. Mitigated in JS: the Windows and macOS
   providers now cap the SendInput fallback at 1 000 chars (~10 s worst
   case). A native-side fix (chunked/async injection, or a shorter pace)
   removes the freeze entirely.

## Accepted residual risks (documented, not fixed)

- **`moveCursor` + `click` / `activate` + `type` are two-step global input**
  (not atomic). The gap between the two native calls is microseconds of
  synchronous code and every input path re-verifies activation right before
  injecting, but a physical user or other software moving focus inside the
  gap can redirect one input event. Fixing this needs merged single-call
  native primitives (move+click atomically).
- **The X11 helper binary resolves from PATH by default**
  (`dsh-computer-use-x11-helper`). The `DSH_COMPUTER_USE_X11_HELPER` override
  must be absolute, but the default name still goes through PATH resolution.
  PATH planting runs at engine privilege (no elevation, single-user desktop),
  and the helper needs a Linux toolchain to rebuild — left as a documented
  limitation for the Linux package.

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
- The HWND generation property (`DSH_CU_WINDOW_GENERATION`, now random) and
  the FNV-1a UIA checksum (now with length-prefixed strings) are sound
  TOCTOU/staleness guards.

## Linux X11 helper (src/providers/linux/x11/helper.c) — audited 2026-08

- The helper now echoes the request `id` in every response; the Node provider
  matches strictly by id, so the echo is part of the protocol contract.
- `keycode_for_name` refuses every Super/Meta/Hyper spelling and no longer
  accepts raw numeric keycodes (an arbitrary-keycode injection backdoor).
- `method_activate_window` polls `_NET_ACTIVE_WINDOW` (~500 ms) and reports
  `false` when the WM did not actually activate the target — the provider
  fails closed and never injects global input into another window.
- X11 format-32 property reads go through `card32_at` (no more `Window*`
  dereference of a 32-bit-unit buffer on LP64). **NOTE:** the helper binary
  must be rebuilt (`make -C src/providers/linux/x11`) on Linux — the source
  fix does not propagate to previously installed binaries.
- Remaining accepted limitations: `json_field` is a substring scanner (safe
  because the trusted Node caller always emits `id`/`method` first), text is
  ASCII-only (non-ASCII fails with `UNSUPPORTED_TEXT`), AT-SPI/clipboard are
  stubs.

## macOS draft (src/providers/macos/src/provider.mm) — audited 2026-08

- Never compiled on a real Mac (CI builds non-fatally). Fixed during audit:
  duplicate `ownerPid` declaration in `GetWindow` (compile error) and
  `RuntimeInfo` reporting "arm64" on Intel (pointer-size arch guess).
- Clipboard snapshots received the Windows cap + clear-on-dispose pattern
  (see round-1 item 1); `GetClipboardText` removed with the Windows cleanup.
