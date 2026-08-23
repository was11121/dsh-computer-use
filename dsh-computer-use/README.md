# dsh-computer-use

DSH 的 Windows 桌面控制插件。它向 DSH Agent 提供窗口观察、截图、UI Automation 观察以及鼠标、键盘和应用启动工具。

## 当前状态

| 平台 | 状态 |
|---|---|
| Windows 10/11 x64 | 当前唯一按可用路径维护的平台 |
| macOS | 未发布草案，尚未完成目标平台验证 |
| Linux X11 | 未发布草案，能力不完整且尚未作为安装包发布 |
| Linux Wayland | 受限兼容骨架，不提供完整桌面控制 |

macOS/Linux 的 provider、helper 和 native addon 源码不能代表已经支持对应平台。不要在生产环境中把这些目录或 `packages/` 下的占位包当作可安装发行版。

## 工作方式

```text
DSH Agent
  │ computer_* 工具
  ▼
插件 core：授权 / 审批 / observation / 能力检查
  │
  ▼
Windows provider：Node-API → Win32 / UI Automation
```

插件不依赖 Python、pip 或外部 sidecar。没有匹配的预编译 native 二进制时，Windows 安装需要 Visual Studio Build Tools、MSVC 和 node-gyp。

## 工具

- `computer_list_apps`：列出当前可操作的窗口。
- `computer_get_window_state`：获取目标窗口截图，并可返回 UI Automation 观察快照、`screenshotPath` 和 `observationId`。
- `computer_activate_window`：激活目标窗口，需要交互审批。
- `computer_click`：按最近一次 observation 的窗口相对坐标点击，也可使用观察中的元素引用。
- `computer_type_text`：输入文本，优先通过会话隔离的剪贴板粘贴，失败时回退 Unicode 注入；SendInput 回退路径单次最多 1000 个字符。
- `computer_press_key`：发送白名单内的组合键；Windows/Meta 修饰键和系统组合键不允许使用。
- `computer_scroll`：发送真实 Windows 滚轮输入。
- `computer_drag`：在目标窗口内拖动。
- `computer_launch_app`：启动应用，经过审批门禁和启动黑名单检查。

控制期间可能显示目标窗口边框、顶部提示和 DSH 指针。截图时指针会暂时隐藏，避免干扰视觉模型；引擎异常退出后，下一次加载会尝试恢复系统指针。

## 依赖

- Windows 10/11 x64
- Node.js 22.19 或更高版本
- `dsh-computer-use-native` Windows x64 Node-API provider

## 安装到 DSH web profile

本目录就是插件包根目录。将它克隆或链接到本地插件目录，然后在 DSH web profile 中声明链接依赖。

1. 在 profile 的 `package.json` 的 `dependencies` 中加入：

   ```json
   "dsh-computer-use": "link:C:/path/to/dsh-computer-use"
   ```

2. 在同一 profile 配置的 `dsh.profile.bundles` 中加入 `"dsh-computer-use"`。
3. 在 profile 目录执行：

   ```bash
   dsh plugin --profile web install
   ```

4. 重启 DSH。首次安装若需要本地编译 native addon，请先准备 MSVC 生成工具链。

## 配置

```yaml
computer-use:
  enabled: true
  allowControl: false
  requireApproval: true
  skipApprovalWhenPolicyNever: true
  screenshotDir: computer-use/screenshots
  screenshotRetention: 86400000
  overlayEnabled: true
  overlayIdleMs: 10000
  overlayText: DSH 正在控制你的电脑
```

配置说明：

- `allowControl` 默认关闭。用户通过授权气泡明确开启后，插件才允许执行桌面控制动作。
- `requireApproval` 控制点击、输入、按键、启动和激活等交互动作是否逐次请求确认。
- `skipApprovalWhenPolicyNever` 为 `true` 时，会话策略为 `never` 可跳过逐次审批，但不能绕过 `allowControl`；设为 `false` 时按 fail-closed 语义拒绝此类调用。
- `screenshotDir` 只能使用 DSH home 下的相对路径，路径会经过 realpath containment 校验。
- `screenshotRetention` 的单位是毫秒；小于等于 0 表示不自动清理。
- `overlayColor` 已废弃，指示颜色固定为 DSH 品牌蓝，仅保留旧配置兼容。

## 与视觉模型配合

当主模型不能直接查看图片时，推荐按以下顺序操作：

1. 用 `computer_list_apps` 选择目标窗口。
2. 用 `computer_get_window_state` 获取截图和 observation，并记录返回的 `observationId`。
3. 将 `screenshotPath` 交给 `vision_analyze` 等视觉工具分析。
4. 根据分析结果调用动作工具，并传入同一次 observation 的 `observationId`。
5. 每个动作完成后重新获取窗口状态；元素索引、坐标和 UI 树只对对应 observation 有效。

## 安全模型

### 授权与审批

- `allowControl` 默认关闭；切换授权带有限速与审计记录，并会清理正在进行的控制会话。
- 交互动作在 `requireApproval: true` 时逐次请求用户确认；没有有效审批上下文时按拒绝处理。
- 审批上下文按调用链隔离，并发会话不能把一个会话的动作挂到另一个会话的审批卡片下。

### observation 熔断

- 每个动作都绑定有时效的 `observationId`，并校验 session、agent 和目标窗口归属；跨会话重放会被拒绝。
- 执行动作前会复核 PID、进程路径、窗口类名、矩形和随机 generation 令牌，防止 HWND 被复用后继续操作旧目标。
- 目标窗口身份或 UI Automation checksum 发生变化时，动作会失败并要求重新观察。
- UI Automation 树有节点数和深度上限；截断时明确标记 `uiaTruncated`，不会伪造完整树。

### 输入与启动边界

- 不发送 Windows/Meta 修饰键和系统级组合键，例如 Alt+Tab、Ctrl+Alt+Del。
- 点击、滚动和拖动坐标必须位于目标窗口矩形内；前台激活失败时不会向未知窗口注入全局输入。
- 应用启动拒绝 shell、脚本宿主、解释器、执行包装器（如 `env`、`nohup`、`wsl`、`schtasks`）、脚本和快捷方式扩展名、NTFS 8.3 短名、控制字符与路径穿越。

### 防自操作与数据清理

- 通过进程路径、类名、品牌标题和句柄状态识别并禁止操作 DSH 自身窗口。
- 截图只渲染目标窗口自身，不提供全桌面截图；截图路径限制在 DSH home 内并按配置清理。
- 剪贴板快照按 session/agent 隔离并设数量上限；恢复失败时清理剪贴板，减少敏感输入残留。

## 已知限制

这些限制是当前设计的一部分，不应被安装说明或安全概要隐藏：

- 回环 RPC 信任整个 DSH web realm。同一 DSH 窗口内的其他脚本理论上可能影响 `allowControl`；彻底修复需要宿主级隔离。
- `moveCursor` 后点击、激活后输入等路径不是原子操作。物理用户或其他软件可能在两个 native 调用之间改变焦点；执行前虽会再次校验，无法消除全部竞态。
- X11 helper 默认按 PATH 查找。`DSH_COMPUTER_USE_X11_HELPER` 覆盖值必须是绝对路径，Linux 发布前还必须在目标 Linux 环境重新编译 helper。
- 截断 UI Automation 树只能校验已返回的部分树，不能证明未返回的节点没有变化。
- macOS/Linux 尚未达到发布门槛，不能依据 provider 的源码骨架推断完整能力或兼容性。

native 层审计记录见 [`docs/NATIVE_SECURITY_NOTES.md`](docs/NATIVE_SECURITY_NOTES.md)。

## 开发与验证

```bash
npm install
npm run typecheck
npm run build
npm run verify:build
npm run test:contract
npm run test:native
node scripts/package-check.mjs
```

`src/` 是 TypeScript 源码，`lib/` 是运行时加载的构建产物，`client/` 由构建脚本同步。修改 `src/` 后必须重新执行 `npm run build`；只看到源码测试通过，不代表运行时产物已经更新。

跨平台验证策略见 [`docs/DEV_CROSS_PLATFORM.md`](docs/DEV_CROSS_PLATFORM.md)，目标和发布门禁见 [`docs/CROSS_PLATFORM_PLAN.md`](docs/CROSS_PLATFORM_PLAN.md)。

## 许可证

本插件目录包含 [`LICENSE`](LICENSE)，内容为 BSD 3-Clause License。使用、修改或分发时请以该文件中的版权声明和条件为准，并遵守第三方依赖各自的授权条款。
