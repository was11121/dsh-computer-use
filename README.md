# dsh-computer-use

[![CI](https://github.com/xueLan-io/dsh-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/xueLan-io/dsh-computer-use/actions/workflows/ci.yml)

DSH 的桌面控制插件仓库：让 DSH Agent 观察（截图 + UI Automation）并操作（鼠标 / 键盘 / 启动应用）Windows 桌面。插件为纯 Node.js 原生运行时（Node-API 直调 Win32 / UIA），**无 Python、无 pip、无外部 sidecar**。

> **当前仅 Windows 10/11 x64 是可发布平台。** macOS 与 Linux provider 属于未发布草案（CI 仅做非致命构建冒烟），不要在生产环境视为已支持。

## 仓库结构

```
.
├── .github/workflows/ci.yml   # 四平台 CI（见下）
├── AGENTS.md                  # 仓库结构约定（源码在哪、什么不要改）
└── dsh-computer-use/          # 插件本体（独立 npm 包）
    ├── src/                   # TypeScript 源码（测试跑这里）
    ├── lib/                   # 构建产物（运行时加载这里；由 src/ 编译）
    ├── native/                # Windows C++ addon（provider.cc + 预编译 .node）
    ├── src/providers/         # windows / macos(draft) / linux(draft) provider
    ├── client/                # DSH web 客户端半体（授权气泡面板）
    ├── packages/              # 未来分平台发布包占位（未发布）
    ├── tests/contracts/       # 契约测试（node:test，101 个用例）
    └── docs/                  # 跨平台计划、native 安全审计记录
```

插件的使用说明、配置项与完整安全模型见 **[`dsh-computer-use/README.md`](dsh-computer-use/README.md)**。

## CI 矩阵

| Job | 平台 | 内容 |
|---|---|---|
| `core` | Ubuntu | 类型检查 + 契约测试（`--ignore-scripts`） |
| `windows` | Windows | 完整构建（含 native addon）+ 契约测试 + `npm pack --dry-run` |
| `macos` | macOS | 类型检查 + 契约测试；native addon 为 draft，构建非致命（`continue-on-error`） |
| `linux` | Ubuntu | X11 helper 构建（`make`）+ Xvfb 端到端冒烟 |

## 快速开始

```bash
cd dsh-computer-use
npm install
npm run typecheck        # TS 类型检查
npm run build            # src/ -> lib/ + 同步 client
npm test                 # 契约测试
npm run test:native      # native addon 加载冒烟
```

**构建纪律**：测试跑 `src/`，运行时加载 `lib/`。改动 `src/` 后必须 `npm run build` 并一起提交 `lib/`；CI 用 `npm run verify:build` 校验两者一致（2026-08 审计曾发现一整批安全修复停留在 src 未构建、运行时从未生效）。

安装到 DSH profile、配置项、与视觉模型配合的工作流，见插件 README 的[安装](dsh-computer-use/README.md#安装dsh-web-profile)与[配置](dsh-computer-use/README.md#配置)章节。

## 安全

本仓库在 2026-08 经过三轮安全审计，修复均已落地并带回归测试（审批上下文跨会话隔离、随机窗口 generation 令牌防 HWND 复用、启动黑名单含 LOLBIN 与 8.3 短名、剪贴板快照上限与清理、危险 native 导出删除、光标替换崩溃恢复等）。

分层的防护模型（授权门 / 逐次审批 / observation 熔断 / 输入边界 / 防自操作）见插件 README 的[安全模型](dsh-computer-use/README.md#安全模型)；**如实记录的已知限制**（回环 RPC 信任 web realm、两步输入非原子等）见[已知限制](dsh-computer-use/README.md#已知限制如实记录)，native 层审计详情见 [`dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md`](dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md)。

## 分支

- `feat/node-native-rewrite` — 活跃开发分支（Node 原生重写 + 2026-08 安全审计修复）

## License

BSD-3-Clause
