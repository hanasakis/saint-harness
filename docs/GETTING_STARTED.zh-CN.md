# Saint Harness：朋友拉取与启动指南

仓库地址：<https://github.com/hanasakis/saint-harness>

这是公开的 Windows 桌面应用源码仓库。拉取不需要登录 GitHub，也不需要作者的模型密钥。每位使用者的项目、会话和 API Key 保存在自己的电脑上。

## 1. 准备环境

- Windows 10/11 x64；当前版本只在 Windows 上完成桌面验证。
- Git：<https://git-scm.com/downloads/win>
- Node.js 24.x 或更高版本（包含 npm）：<https://nodejs.org/en/download>
- 能连接 GitHub、npm，以及你使用的模型服务。源码安装需要下载 Electron 与 Pi。

安装后重新打开 PowerShell，检查：

```powershell
git --version
node --version
npm.cmd --version
```

以下示例使用 `npm.cmd`，可避免 Windows PowerShell 阻止 `npm.ps1` 的问题，无需调整系统执行策略。建议在较短的路径中克隆，例如 `C:\Projects`。

## 2. 首次拉取并启动

在你准备保存项目的目录打开 PowerShell，逐行执行；遇到错误时先处理该条命令：

```powershell
git clone https://github.com/hanasakis/saint-harness.git
cd saint-harness
npm.cmd ci
npm.cmd ci --prefix runtime --omit=dev
npm.cmd run dev
```

第一条安装桌面开发依赖和 Electron，第二条安装独立 Pi 引擎。两步都需要执行。首次安装可能需要数分钟；后续启动只需：

```powershell
cd 你的项目路径\saint-harness
npm.cmd run dev
```

开发终端需要保持打开。修改 React 界面时页面会热更新；修改 Electron 主进程时，关闭应用，在终端按 Ctrl+C，再重新运行 `npm.cmd run dev`。

如果希望运行编译后的版本：

```powershell
npm.cmd run build
npm.cmd start
```

## 3. 第一次使用

1. 点击「从项目开始」或侧栏工作空间的 `+`，选择要操作的本机目录。
2. 点击左下角「我的工作空间」，配置 Anthropic、OpenAI、DeepSeek，或 OpenAI Chat Completions 兼容服务。
3. API Key 使用你自己的服务账号。自定义服务还需填写 API 地址、模型 ID 和上下文长度；本地免密服务可以不填 Key。
4. 保存后，在输入框下方选择模型。先发送一个只读任务，例如「阅读 README，概述这个项目的结构」。
5. Pi 请求执行命令或访问需确认的位置时，界面会显示审批。默认审批模式并非系统沙箱。

文件改动可在右侧「改动」中查看；「预览」是文本文件预览，「终端」是工具日志。详细功能和限制见仓库首页。

## 4. 拉取作者的后续更新

先关闭应用和开发终端，在仓库目录执行：

```powershell
git status
git pull --ff-only
npm.cmd ci
npm.cmd ci --prefix runtime --omit=dev
npm.cmd run dev
```

如果有自己尚未提交的修改，先保存到自己的分支并提交，再同步；不要用 `reset --hard` 或删除整个目录来处理冲突。如果 `git pull --ff-only` 报告分叉，保留本地提交，与作者确认合并方式。

这里更新的是 Saint 源码和仓库内声明的 Pi 版本。应用中的「Pi Engine → 空闲时自动更新」则更新用户数据目录内的 Pi 运行时；它不会自动拉取 GitHub 源码，也不会自动替换桌面应用。

## 5. 打包给不写代码的朋友

在完成两次依赖安装后执行：

```powershell
npm.cmd run package
```

成品位于 `release/win-unpacked/`，双击其中的 `Saint Harness.exe`。必须保留该目录中的 `resources`、DLL 等全部文件。也可以直接生成压缩包：

```powershell
npm.cmd run package:zip
```

压缩包位于 `release/`。接收者解压整个压缩包后运行 EXE；成品包含 Node 和 Pi，但 Git 审阅仍需要电脑安装 Git。当前产物是未签名的开发版。

## 6. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `git`、`node` 或 `npm` 不是命令 | 安装相应软件，重新打开终端，确认 PATH 生效。 |
| 提示禁止运行 `npm.ps1` | 使用本指南中的 `npm.cmd`，无需关闭系统安全策略。 |
| Electron 下载超时 | 检查终端到 GitHub 的连接与已配置代理；修复后在仓库目录重新执行 `npm.cmd ci`。浏览器能访问不代表 npm/Git 的网络已通。 |
| 提示找不到 Pi 或运行时文件 | 在仓库目录执行 `npm.cmd ci --prefix runtime --omit=dev`，然后重启应用。 |
| `npm start` 找不到主文件 | 先执行 `npm.cmd run build`，或直接使用 `npm.cmd run dev`。 |
| 模型列表为空 | 先打开工作空间，再在模型设置中配置有效的 API 连接，保存后重新选择模型。 |
| API 报 401 / 403 / 404 | 核对自己的 Key、API 地址、模型 ID 和账号权限；不要把 Key 粘贴到 GitHub Issue 或提交记录。 |
| 开发端口 5187 已占用 | 关闭之前启动的开发终端和进程，再重新启动。 |
| 无 Git 改动列表 | 确认已安装 Git、所选目录属于 Git 仓库；普通目录仍可使用文件工具和文本预览。 |

## 7. 一起开发

公共读取权限不等于提交权限。可以 Fork 后提交 Pull Request；如果作者为你授予仓库写权限，可创建自己的分支：

```powershell
git switch -c codex/your-name-change
# 修改代码后
npm.cmd run build
npm.cmd test
git add 你修改的文件
git commit -m "说明本次改动"
git push -u origin codex/your-name-change
```

随后在 GitHub 提交 Pull Request。开发者的真实数据位于 `%APPDATA%/Saint Harness/`；不要将密钥、会话、测试数据、运行日志、`node_modules` 或 `release` 加入源码提交。
