# dsh-computer-use

## 平台支持状态

> **当前仅 Windows 10/11 x64 是可发布平台。**
> macOS 与 Linux 的 `DesktopProvider`、原生 helper/addon 属于**未发布草案**，尚未在目标平台编译、运行验证，也没有对应的可安装发布包。不要在生产环境中把 macOS/Linux 视为"已支持"。

DSH 桌面控制插件：让 DSH Agent 操作 Windows 桌面。插件是 Node.js 原生运行时（Node-API 直调 Win32 / UI Automation），不需要 Python、pip 或外部 sidecar。

架构复刻自 Codex Computer Use：

```
DSH 模型
  ↓ 调用 computer_* 工具
dsh-computer-use (Node/Cordis)
  ↓ Node native runtime
dsh-computer-use-native + Win32/UI Automation
  Windows 窗口 / 鼠标 / 键盘
```

首次安装若没有预编译二进制（Prebuild），需要 Windows C++ 生成工具链（Visual Studio Build Tools / MSVC + node-gyp）。

## 工具

- `computer_list_apps`：列出可操作的窗口
- `computer_get_window_state`：截图（保存为 DSH 附件）+ 可选 Windows UI Automation 观察快照
- `computer_activate_window`：激活窗口（需通过交互审批）
- `computer_click`：使用最新 observation 的窗口相对坐标点击
- `computer_type_text`：向目标窗口输入文本（优先剪贴板粘贴；粘贴不可用时回退 Unicode 注入，单次至多 1000 字符）
- `computer_press_key`：发送不包含 Windows/Meta 键的组合键
- `computer_scroll`：使用真实 Windows wheel input 滚动
- `computer_drag`：拖动
- `computer_launch_app`：启动应用（统一审批门禁 + 启动黑名单）

控制期间屏幕四周显示蓝色高亮边框与顶部提示条，鼠标指针切换为蓝色 DSH 光标（截图时临时隐藏，避免干扰视觉模型）。引擎异常退出后，下次加载会自动恢复被替换的系统光标。

授权气泡：DSH 聊天输入框上方的小气泡，打勾前插件**无权**控制电脑。开关经插件自己的 `/computer-use` 回环 RPC 通道读写（带限速与审计日志），不依赖宿主设置白名单。

## 依赖

- Windows 10/11 x64
- Node.js 22.19+
- `dsh-computer-use-native` Windows x64 Node-API provider

UIA 树有节点数和深度边界；截断时会标记 `uiaTruncated`，不会伪造完整树。

## 安装（DSH web profile）

1. 把本插件仓库克隆或链接到本地插件目录（例如 `~/.dsh/plugins/dsh-computer-use`）。
2. 在 DSH profile 的 `package.json`（例如 `~/.dsh/profiles/web/package.json`）的 `dependencies` 中添加：

   ```json
   "dsh-computer-use": "link:C:/Users/<用户名>/.dsh/plugins/dsh-computer-use"
   ```

3. 在同一个文件的 `dsh.profile.bundles` 中添加 `"dsh-computer-use"`。
4. 在 `~/.dsh/profiles/web` 目录下执行插件安装与构建：

   ```bash
   dsh plugin --profile web install
   ```

5. 重启 DSH。

## 配置

```yaml
# ~/.dsh/settings.yaml (或 DSH 配置目录下的 settings.yaml)
computer-use:
  enabled: true
  allowControl: false      # 授权开关（默认关闭！气泡打勾后才允许控制）
  requireApproval: true    # 交互动作（点击/输入/按键/启动/激活）先征求用户同意
  skipApprovalWhenPolicyNever: true  # 会话策略为"不再询问"(never) 时跳过交互审批，仅由 allowControl 把关；
                                     # 设为 false 则遵循官方 fail-closed 语义（此类操作会被拒绝）
  screenshotDir: computer-use/screenshots   # 仅允许 DSH home 下的相对路径（realpath 校验）
  screenshotRetention: 86400000             # 截图保留时长；<=0 表示永不清理
  overlayEnabled: true     # 控制时显示蓝色高亮 + 顶部提示 + 自定义鼠标
  overlayIdleMs: 10000     # 最后一次操作后多久自动隐藏指示
  overlayText: DSH 正在控制你的电脑
```

> `overlayColor` 已废弃：指示颜色固定为 DSH 品牌蓝，该项仅为旧配置兼容保留。

## 配合视觉模型

主模型（如 DeepSeek）不能看图时，让 Agent：

1. `computer_list_apps` 选窗口
2. `computer_get_window_state` 截图和 UIA 快照（返回图片附件、`screenshotPath`、`observationId`）
3. `vision_analyze`（来自 `dsh-vision-model`）传 `imagePath=screenshotPath` 分析截图
4. 根据分析结果调用动作工具，并传入同一次观察返回的 `observationId`
5. 每次动作后**必须**重新 `computer_get_window_state` 刷新（元素索引和坐标只对当次有效）

## 安全模型

插件按纵深分层设防（2026-08 三轮安全审计后落地）：

**授权与审批**
- `allowControl` 默认关闭，需在界面显式授权；每次翻转带限速（300ms）与审计日志，并立即销毁进行中的控制会话。
- `requireApproval: true` 时，点击、输入、按键、启动、激活窗口均请求用户逐次确认；无审批上下文的调用 fail-closed 拒绝。
- 审批请求与 observation 归属按调用链隔离（AsyncLocalStorage）：并发会话无法把 A 会话的动作挂在 B 会话的审批卡片下。

**观察熔断（TOCTOU 防线）**
- 所有动作绑定 3 分钟有效期的 `observationId`，且校验会话/agent 归属，跨会话重放直接拒绝。
- 动作执行前重新校验窗口身份（PID、进程路径、类名、矩形），并以**随机 64 位窗口 generation 令牌**复核 HWND 未被复用。
- 目标窗口变化、UIA 树 checksum 不一致时自动熔断，要求重新观察。

**输入边界**
- 永不发送 Windows/Meta 修饰键及系统组合键（Alt+Tab、Ctrl+Alt+Del 等）；键码经白名单映射。
- 点击/滚动/拖动坐标校验在目标窗口矩形内，越界直接报错。
- 前台激活失败时回退到后台安全的 UIA invoke / PostMessage，绝不向错误窗口注入全局输入。

**启动黑名单**
- 拒绝 shell、脚本宿主、解释器（含版本化名称）、执行包装器（`env`/`nohup`/`wsl`/`schtasks` 等 LOLBIN）、脚本与快捷方式扩展名（`.bat`/`.lnk`/`.desktop` 等）、NTFS 8.3 短名、控制字符与路径穿越。

**防自操作与隔离**
- 硬性禁止对 DSH 自身窗口操作（进程路径、类名、品牌标题、句柄记忆四重识别，不可关闭）。
- 截图仅渲染目标窗口自身（PrintWindow），不泄露被遮挡的其他窗口；截图目录被约束在 DSH home 内（realpath 防符号链接逃逸），过期自动清理。
- 剪贴板快照按会话隔离、数量与清理受控；恢复失败时擦除剪贴板，防止敏感输入残留。

## 已知限制（如实记录）

- **回环 RPC 信任整个 DSH web realm**：同一 DSH 窗口内的任何脚本（包括其他客户端插件）理论上都能翻转 `allowControl` 开关（有限速与日志，无身份校验）。彻底修复需要宿主级隔离。
- **两步全局输入非原子**：`moveCursor→click`、`activate→type` 之间的微秒级间隙理论上可被物理操作重定向单次输入；每条输入路径在注入前均重新校验激活状态。
- **X11 helper（未发布）默认经 PATH 解析**二进制名；环境变量覆盖必须绝对路径。Linux 包发布前需在 Linux 上重新编译 helper（`make -C src/providers/linux/x11`）。
- 截断的 UIA 树只校验截断边界内的变化（部分树校验的固有限制）。

详见 `docs/NATIVE_SECURITY_NOTES.md`（native 层审计记录与已接受残余风险清单）。

## 开发

```bash
npm install
npm run typecheck       # TS 类型检查
npm run build           # 编译 src/ -> lib/ 并同步 client
npm run verify:build    # CI 用：确认 lib/ 与 src/ 一致（防止构建产物落后于源码）
npm test                # 契约测试（tests/contracts）
npm run test:native     # native addon 加载冒烟
```

改动 `src/` 后必须 `npm run build` 并提交 `lib/`——运行时加载 `lib/`，测试跑 `src/`，两者不一致时测试通过不代表运行正确。

## License

BSD-3-Clause
