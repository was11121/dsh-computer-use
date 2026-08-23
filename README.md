# dsh-computer-use

[![CI](https://github.com/was11121/dsh-computer-use/actions/workflows/ci.yml/badge.svg)](https://github.com/was11121/dsh-computer-use/actions/workflows/ci.yml)

DSH 的桌面控制插件仓库。插件向 DSH Agent 提供 `computer_*` 工具，用于观察和操作 Windows 桌面，包括枚举窗口、截图、读取 UI Automation 树，以及执行点击、输入、按键、滚动、拖动和应用启动。

插件运行时完全基于 Node.js。Windows native 层通过 Node-API 直接调用 Win32 与 UI Automation，不依赖 Python、pip 或外部 sidecar 进程。

## 平台状态

当前只有 Windows 10/11 x64 具备完整的实现、构建和本地运行路径。

| 平台 | 当前状态 | 说明 |
|---|---|---|
| Windows 10/11 x64 | 当前实现 | `dsh-computer-use` 的主要目标平台；包含 Windows native addon。 |
| macOS | 未发布草案 | 有 provider 与 native 源码骨架，尚未完成真实 macOS 编译、运行和端到端验证。 |
| Linux X11 | 未发布草案 | 有 X11 helper 与 provider；辅助功能树、剪贴板等能力仍未完成，不能当作发行版支持。 |
| Linux Wayland | 受限骨架 | 当前仅保留受限能力，不能视为完整桌面控制支持。 |

CI 中的 macOS 构建仍是非致命草案检查，Linux CI 的 X11 烟测也不等于已经发布 Linux 包。平台支持状态以真实目标平台验证和发布包为准。

## 架构

```text
DSH 模型
  │  调用 computer_* 工具
  ▼
dsh-computer-use（Node/Cordis 插件）
  │  授权门 / 逐次审批 / 能力检查 / observation 校验
  ▼
Windows provider（Node-API native addon）
  │  Win32 / UI Automation
  ▼
窗口 / 鼠标 / 键盘 / 剪贴板
```

仓库当前保留跨平台 provider 的实验性抽象，但 Windows 是唯一应按可用产品路径安装和验证的平台。

## 快速验证

```bash
cd dsh-computer-use
npm install
npm run typecheck
npm run build
npm run verify:build
npm test
npm run test:native
```

测试读取 `src/`，运行时加载 `lib/`。修改 `src/` 后必须执行 `npm run build`，并检查生成的 `lib/` 与 `client/` 是否一并更新。`npm run verify:build` 用于防止运行时产物落后于源码。

## 安装到 DSH

本仓库的 npm 包位于 `dsh-computer-use/` 子目录。将仓库克隆到本地后，把这个子目录链接到 DSH web profile 的插件目录。

1. 在 profile 的 `package.json` 中添加本地依赖，路径替换为插件目录的绝对路径：

   ```json
   {
     "dependencies": {
       "dsh-computer-use": "link:<插件目录的绝对路径>"
     }
   }
   ```

2. 在同一 profile 配置的 `dsh.profile.bundles` 中加入 `"dsh-computer-use"`。
3. 在 profile 目录下执行：

   ```bash
   dsh plugin --profile web install
   ```

4. 重启 DSH，并确认授权气泡处于关闭状态后再开始测试。

插件的完整配置、视觉模型协作流程和安全限制见 [`dsh-computer-use/README.md`](dsh-computer-use/README.md)。

## 安全概要

- `allowControl` 默认关闭；交互动作默认逐次请求用户确认，缺少审批上下文时按拒绝处理。
- 动作绑定有时效的 `observationId`，执行前会复核窗口身份、随机 generation 令牌和 UI 树状态。
- Windows/Meta 修饰键与系统组合键被拒绝；鼠标坐标必须落在目标窗口范围内。
- 应用启动经过黑名单检查，拒绝 shell、脚本宿主、解释器、常见执行包装器、危险扩展名和路径穿越。
- 插件禁止操作 DSH 自身窗口；截图只渲染目标窗口；截图目录和剪贴板快照都有隔离与清理约束。

这些措施不等同于宿主级安全隔离。回环 RPC 信任整个 DSH web realm、两步全局输入存在非原子间隙等限制，见插件 README 与 [`dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md`](dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md)。

## CI

`.github/workflows/ci.yml` 当前定义四个 job：

- `core`（Ubuntu）：类型检查与契约测试。
- `windows`（Windows）：安装、构建、契约测试和 `npm pack --dry-run`。
- `macos`（macOS）：类型检查与契约测试，native addon 构建仍为非致命草案检查。
- `linux`（Ubuntu）：X11 helper 编译与 Xvfb JSON-lines 烟测。

CI 通过不代表 macOS/Linux 已达到发布条件。

## 仓库结构

```text
.
├── .github/workflows/ci.yml   # CI（core / windows / macos / linux）
├── AGENTS.md                  # 仓库协作约定
├── scripts/                   # 仓库级辅助脚本
└── dsh-computer-use/          # 插件本体（独立 npm 包）
    ├── src/                   # TypeScript 源码
    ├── lib/                   # 构建产物，运行时加载
    ├── native/                # Windows C++ addon
    ├── client/                # DSH web 客户端授权面板
    ├── tests/contracts/       # 跨平台契约测试
    ├── packages/              # 未来分包占位，未发布
    └── docs/                  # 安全审计与跨平台文档
```

## 文档导航

- [`dsh-computer-use/README.md`](dsh-computer-use/README.md)：安装、配置、工具、视觉模型工作流、安全模型和已知限制。
- [`dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md`](dsh-computer-use/docs/NATIVE_SECURITY_NOTES.md)：native 层审计记录。
- [`dsh-computer-use/docs/DEV_CROSS_PLATFORM.md`](dsh-computer-use/docs/DEV_CROSS_PLATFORM.md)：没有实机时的开发与验证策略。
- [`dsh-computer-use/docs/CROSS_PLATFORM_PLAN.md`](dsh-computer-use/docs/CROSS_PLATFORM_PLAN.md)：跨平台目标、阶段和发布门禁。

## 许可证

插件目录中的 [`dsh-computer-use/LICENSE`](dsh-computer-use/LICENSE) 是 BSD 3-Clause License。版权声明和许可证条件以该文件为准；使用、修改或分发时请保留原始声明，并同时遵守第三方依赖各自的授权条款。
