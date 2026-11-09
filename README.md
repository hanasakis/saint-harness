# Saint Harness

基于 Pi 的个人 Agent 桌面工作空间，Windows x64 首版 **0.1.0**。界面采用已确认的黑白设计与新版玻璃棱镜，保留侧栏字标、原生窗口、对话、输入区和右侧审阅面板。

仓库：<https://github.com/hanasakis/saint-harness>。首次拉取请阅读 [朋友拉取与启动指南](docs/GETTING_STARTED.zh-CN.md)。当前仓库公开，拉取不需要邀请或 GitHub 登录；提交修改需要仓库写权限，或通过 Fork / Pull Request 协作。

## 从 GitHub 拉取并运行

准备 Windows 10/11 x64、Git 和 Node.js 24.x 或更高版本，在 PowerShell 中执行：

```powershell
git clone https://github.com/hanasakis/saint-harness.git
cd saint-harness
npm.cmd ci
npm.cmd ci --prefix runtime --omit=dev
npm.cmd run dev
```

第一次安装会下载 Electron 与 Pi，需能访问 GitHub 和 npm。每条命令成功后再执行下一条；窗口打开后，选择项目目录并配置你自己的模型 API。仓库不包含作者的密钥、聊天记录或已安装依赖。这里只验证了 Windows 版本。

## 打开应用

源码运行可使用上面的 `npm.cmd run dev`；执行 `npm.cmd run package` 后，会生成 `release/win-unpacked/Saint Harness.exe`。生成的程序已包含 Electron、Node 和 Pi，无需另装 Node。交接成品时发送整个 `win-unpacked` 文件夹，或压缩包；不能只复制一个 exe。Git 仓库本身不包含这些构建产物。

1. 点击「从项目开始」或工作空间旁的 `+`，选择本机项目目录。
2. 点击左下角「我的工作空间」，配置 Anthropic、OpenAI、DeepSeek 或自定义 OpenAI Chat Completions 兼容服务。自定义服务填写实际 API 地址、模型 ID 和上下文长度；本地免密服务可不填 Key。
3. 在输入框下方选择模型，输入任务并发送。按 Enter 发送，Shift+Enter 换行；Ctrl+N 新建会话，Ctrl+K 搜索。
4. 在「项目文件」「待审阅」查看实际文件与 Git 改动。Git 审阅需要系统已安装 Git；普通目录仍可对话、操作文件及预览文本。

支持流式回复、思考强度、工具执行记录、停止任务、模型切换、技能导入、文本与图片附件、会话搜索、重命名、导出、恢复，以及可调整宽度的右侧面板。图片需模型本身支持视觉。自定义模型当前按文本模型登记。

## Pi 持续更新

Pi **1.5.0** 独立安装在 `runtime/`，桌面界面通过 Pi 官方 JSONL RPC 接口连接，不修改 Pi 源代码。点击左下角「Pi Engine」管理：

- 默认自动检查 npm 上游稳定版；启动后检查一次，此后每 6 小时检查。
- 开启「空闲时自动更新」即可自动跟随稳定版；也可以手动更新。
- 下载到新的版本目录，实际启动 Pi 验证 RPC 和权限扩展后再切换。运行任务时不切换；上一个版本保留，可一键恢复。
- 网络中断或新版本连接失败时保留现有版本。安装记录保存在对应目录的 `install.log`。
- 可以连接已有的 Pi JS/EXE；外部引擎使用原安装方式更新。

这个机制更新的是 Pi 引擎。Saint 桌面本身的新版仍需替换应用目录；上游若更改 RPC 或扩展接口，仍可能需要更新适配层。

## 执行权限和本机数据

默认「自动审批」允许工作空间内普通文件工具；终端命令、其他工具、明确的敏感路径和工作空间外路径会询问。「每次询问」逐次审批；「完全访问」需要本机确认。拒绝或取消会阻止相应工具操作。此功能是工具审批，**不是操作系统沙箱**；已经允许的命令、扩展仍具有当前系统账户权限。

Pi 项目配置与扩展的信任需要单独确认。模型返回的 HTML 不执行，远程图片不自动加载，文件预览限制在当前工作空间内。密钥使用 Windows 用户级加密保存，不回传到渲染界面；运行时只通过进程环境提供给 Pi。

数据目录：`%APPDATA%/Saint Harness/`。`workspace.json` 保存工作空间、会话索引、加密后的凭据和引擎选择；`sessions/` 保存 Pi 原生会话；`pi-agent/` 保存独立配置；`runtimes/` 保存下载版本。卸载或替换程序目录不删除这些数据。会话「归档」只移除侧栏索引，原始会话文件保留。备份时整个复制数据目录；Windows 加密凭据不能直接迁移给其他系统账户。

## 开发与验证

```powershell
npm ci
npm ci --prefix runtime --omit=dev
npm run dev
```

开发模式热更新 React 页面；修改 Electron 主进程后需重启。构建和验证：

```powershell
npm run build
npm test
npm run test:desktop
npm run test:runtime
npm run package
```

`test:desktop` 启动真实 Electron 和 Pi，使用本机可控模型服务验证真实文件写入、拒绝审批、Git 审阅、停止、重启恢复和小窗口布局，不调用收费 API。`test:runtime` 连接 npm 下载真实 Pi，验证更新和回退；仅将起始版本比较模拟为旧版本以触发更新。两类测试使用 `.test-data/`，不使用用户会话或真实凭据。

打包后的回归：`$env:SAINT_TEST_EXE=(Resolve-Path 'release/win-unpacked/Saint Harness.exe').Path; npm run test:desktop`。此变量仅供测试脚本使用。验收截图与机器可读记录在 `artifacts/`。

## 模块与交接

| 路径 | 责任 |
| --- | --- |
| `src/` | 桌面界面、对话、菜单和审阅视图 |
| `electron/main.ts` | 原生窗口、系统对话框、严格限定的 IPC 操作 |
| `electron/session.ts` | Pi 会话、模型、附件、技能和事件转换 |
| `electron/rpc.ts` | JSONL 协议、请求关联、进程与停止生命周期 |
| `electron/runtime.ts` | Pi 独立安装、更新、验证、切换与回退 |
| `electron/files.ts` | 工作空间文件与 Git 改动读取 |
| `extensions/permissions.mjs` | Pi 工具审批扩展 |
| `shared/types.ts` | 前后端 TypeScript 类型 |
| `public/assets/` | 已确认的品牌图与本地字体 |

当前范围：单窗口、一个前台运行会话；终端页是工具执行日志，文件页是文本预览；尚未实现交互式终端、网页运行预览、订阅账号 OAuth、多人同步和桌面自身自动升级。模型 API 界面已接入，真实商业服务的凭据、计费与实际任务质量需使用你自己的账号验证。当前为本地可用的未签名开发版。

Pi 官方参考：[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[RPC 命令](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)、[安全模型](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)。以当前安装包内 `docs/` 为具体适配依据。

字体、品牌素材和第三方依赖说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目尚未选择通用开源许可证，当前 `package.json` 标记为 `UNLICENSED`。
