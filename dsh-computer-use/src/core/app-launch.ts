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

import { ComputerUseError } from './errors.ts'

export interface AppLaunch {
  app: string
  args: string[]
}

/** Normalize both separator styles so a Windows path cannot smuggle a name. */
function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Script hosts / shells / system tools that must never be launched through the
 * computer-use tool, regardless of how the caller spells their path.
 *
 * Beyond the shells themselves this list covers "execution vehicles": wrappers
 * that execute a command taken from argv (env, nohup, timeout, xargs, ...),
 * document openers that resolve to an arbitrary handler (open, xdg-open,
 * explorer.exe), Windows LOLBINs (wsl, schtasks, forfiles, msbuild, ...), and
 * bytecode runtimes (java, dotnet, ...). Without these, `env bash -c ...` or
 * `explorer.exe evil.lnk` would bypass every blocked shell name.
 */
const BLOCKED_LAUNCH_NAMES = new Set([
  // Windows shells / script hosts / system control tools
  'cmd', 'cmd.exe',
  'powershell', 'powershell.exe',
  'pwsh', 'pwsh.exe',
  'wscript', 'wscript.exe',
  'cscript', 'cscript.exe',
  'mshta', 'mshta.exe',
  'regedit', 'regedit.exe',
  'reg', 'reg.exe',
  'taskmgr', 'taskmgr.exe',
  'conhost', 'conhost.exe',
  'rundll32', 'rundll32.exe',
  'regsvr32', 'regsvr32.exe',
  // Windows execution vehicles / LOLBINs
  'wsl', 'wsl.exe', // runs any Linux binary, e.g. `wsl bash -c ...`
  'explorer', 'explorer.exe', // resolves .lnk/.url/.cpl handlers
  'schtasks', 'schtasks.exe', // /tr registers an arbitrary command
  'forfiles', 'forfiles.exe', // /c cmd /c ...
  'at', 'at.exe',
  'msbuild', 'msbuild.exe', // inline tasks execute C#
  'installutil', 'installutil.exe',
  'msxsl', 'msxsl.exe', // XSLT scripting
  'pcalua', 'pcalua.exe', // COM surrogate launcher
  'dnx', 'dnx.exe', 'csi', 'csi.exe',
  // Unix shells and interpreters
  'sh', 'bash', 'zsh', 'csh', 'tcsh', 'dash', 'ksh', 'fish',
  'python', 'python2', 'python3', 'perl', 'ruby', 'lua', 'node', 'nodejs', 'deno', 'php',
  'osascript', 'osacompile',
  'expect', 'tclsh', 'csh.exe',
  // Unix execution vehicles: run a command taken from argv
  'env', // `env bash -c ...` / `env CMD /c ...`
  'nohup', 'setsid', 'stdbuf', 'timeout', 'watch', 'xargs', 'nice', 'flock', 'taskset',
  'sudo', 'su', 'doas', 'pkexec', 'gksudo', 'gksu',
  'systemd-run', 'systemctl',
  // Tools with built-in command execution
  'find', 'awk', 'gawk', 'sed', 'make', 'git', 'ssh', 'cpio',
  // Bytecode runtimes: execute the file passed in argv
  'java', 'java.exe', 'javaw', 'javaw.exe', 'jshell', 'jshell.exe',
  'dotnet', 'dotnet.exe', 'mono', 'mono.exe', 'electron', 'electron.exe',
  // Document openers: dispatch to an arbitrary registered handler
  'open', 'xdg-open', 'gio', 'gvfs-open', 'gnome-open', 'kde-open',
  // Terminal emulators (interactive shell gateways)
  'terminal', 'iterm', 'iterm2', 'xterm', 'gnome-terminal', 'konsole',
  'alacritty', 'kitty', 'wezterm', 'wt', 'wt.exe', 'windows-terminal',
])

/**
 * Interpreter stems that ship under versioned or suffixed names (`python3.13`,
 * `pythonw`, `pypy3`, `perl5.36`, `lua5.4`). Exact-name matching alone lets a
 * versioned interpreter through, so these prefixes are matched against the
 * executable stem too.
 */
const BLOCKED_LAUNCH_STEM_PATTERNS = [
  /^(?:python|pypy|perl|ruby|php|node|deno|lua)(?:w|[0-9][\w.]*)?$/,
]

/** Reject control characters that can corrupt spawn arguments on any OS. */
function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Extensions that make the OS execute a file as a script/program rather than
 * open it as a document. On Windows `spawn()` runs `.bat`/`.cmd` through
 * cmd.exe, so the blocked-name list alone cannot stop a renamed script: any
 * file carrying one of these extensions is denied outright.
 */
const BLOCKED_LAUNCH_EXTENSIONS = new Set([
  // Windows: CreateProcess executes these (directly or via a script host)
  '.bat', '.cmd', '.com',
  '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.ws', '.wsf', '.wsh', '.wsc', '.hta',
  '.msi', '.msp', '.mst', '.msc', '.cpl', '.scr', '.pif',
  // Windows store/modern app packages: install and execute
  '.msix', '.msixbundle', '.appx', '.appxbundle',
  // Shell-known document types that execute when opened
  '.settingcontent-ms', '.jnlp',
  '.reg', // registry merge
  // Shortcut indirection: resolves to an arbitrary target, bypassing every
  // name check here
  '.lnk', '.url', '.scf', '.shb', '.appref-ms',
  // Unix shells / interpreters (kept for cross-platform parity)
  '.sh', '.bash', '.zsh', '.ksh', '.fish',
  '.py', '.pyw', '.rb', '.pl', '.lua', '.php',
  '.run', // self-extracting shell installer
  // macOS: Finder/`open` executes these through Terminal or Script Editor
  '.command', '.terminal', '.scpt', '.applescript', '.workflow',
  // Linux desktop entries: Exec= is an arbitrary command line
  '.desktop',
  '.jar', // executes via the registered Java runtime
])

/**
 * Validate and normalize a launch request. Throws `UNSAFE_APP` (DENY) when the
 * application is blocked, contains path traversal, or carries control chars.
 */
export function checkLaunchApp(app: unknown, args: readonly unknown[] = []): AppLaunch {
  const value = String(app ?? '').trim()
  if (!value) throw new ComputerUseError('UNSAFE_APP', 'An application name or path is required', 'DENY')
  if (hasControlChars(value)) throw new ComputerUseError('UNSAFE_APP', 'Unsafe application path', 'DENY')
  if (value.includes('..')) throw new ComputerUseError('UNSAFE_APP', 'Unsafe application path', 'DENY')
  // A bare name starting with '-' is parsed as an option by argv wrappers
  // (macOS `open -a`, env wrappers) instead of as an application name.
  if (value.startsWith('-') && !/[\\/]/.test(value)) {
    throw new ComputerUseError('UNSAFE_APP', 'Unsafe application name', 'DENY')
  }

  const base = basenameOf(value).toLowerCase()
  // Match the executable/bundle stem too: `cmd.exe`, `Terminal.app`,
  // `cmd.bat` all reduce to the blocked name.
  const stem = base.replace(/\.(exe|app|cmd|bat|com)$/, '')
  if (BLOCKED_LAUNCH_NAMES.has(base) || BLOCKED_LAUNCH_NAMES.has(stem) ||
      BLOCKED_LAUNCH_STEM_PATTERNS.some((re) => re.test(stem))) {
    throw new ComputerUseError('UNSAFE_APP', 'This application is blocked for computer-use launch', 'DENY')
  }
  // NTFS 8.3 short names (`POWER~1.EXE`, `RUNDLL~1.EXE`) resolve to the long
  // blocked binary at spawn time while matching none of the names above.
  // Genuine 8.3 names are `<=6 chars + '~' + digits`; reject that shape.
  if (/^[^~]{0,6}~\d+/.test(stem)) {
    throw new ComputerUseError('UNSAFE_APP', '8.3 short names cannot be launched by computer-use', 'DENY')
  }
  const dot = base.lastIndexOf('.')
  if (dot > 0 && BLOCKED_LAUNCH_EXTENSIONS.has(base.slice(dot))) {
    throw new ComputerUseError('UNSAFE_APP', 'Script, shortcut and installer files cannot be launched by computer-use', 'DENY')
  }

  const launchArgs = (args ?? []).map(String)
  for (const arg of launchArgs) {
    if (hasControlChars(arg)) throw new ComputerUseError('UNSAFE_APP', 'Unsafe application argument', 'DENY')
  }
  return { app: value, args: launchArgs }
}