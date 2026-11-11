# 版本发布与下载

## 用户下载

打开 [最新 Release](https://github.com/hanasakis/saint-harness/releases/latest)，下载 Saint-Harness-版本-x64.zip，完整解压后启动 Saint Harness.exe。包内已经包含 Pi 与运行环境。版本历史在 [Releases](https://github.com/hanasakis/saint-harness/releases)。

[GitHub Packages](https://github.com/hanasakis/saint-harness/packages) 中的 @hanasakis/saint-harness 保存相同版本的完整 Windows ZIP，无安装脚本。需要 npm 分发方式的开发者，可先按 GitHub 官方说明登录 npm.pkg.github.com，再执行：

```powershell
npm.cmd login --scope=@hanasakis --auth-type=legacy --registry=https://npm.pkg.github.com
npm.cmd pack @hanasakis/saint-harness@0.1.9 --registry=https://npm.pkg.github.com
tar -xf hanasakis-saint-harness-0.1.9.tgz
Expand-Archive -LiteralPath package/Saint-Harness-0.1.9-x64.zip -DestinationPath Saint-Harness
& './Saint-Harness/Saint Harness.exe'
```

npm 登录的密码使用具有 read:packages 权限的个人访问令牌，不要填写账号密码或把令牌提交到仓库。GitHub 的 npm registry 即使是公开包也需要认证；直接下载 Release 无需此步骤。[GitHub npm registry 说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)

## 维护者每次发布

1. 更新 package.json 与 package-lock.json 中的应用版本，例如 npm.cmd version 0.1.10 --no-git-tag-version；Pi 版本仅在确实更新引擎时修改。
2. 新增 docs/releases/v0.1.10.md，写明用户可见变化、下载方式和本版验证范围。
3. 提交并推送 main。Release desktop and package 工作流自动执行安装、核心测试、构建、完整 ZIP 打包，再运行打包版桌面 / 并发 / Side Chat / 剪贴板 / 模型与技能交互测试。
4. 测试通过后建立 Release 草稿，上传 ZIP 和 npm TGZ，发布并核对 GitHub Packages 版本，最后公开 Release。对应 Git 标签指向本次实际构建的提交。
5. 流程会以未登录方式完整下载 ZIP 和 TGZ，核对大小、压缩格式及与本次构建的一致性，并检查 Packages 为 Public。确认 Actions 成功后再通知用户新版可用。若失败，修复后可手动运行同一个工作流；仍为草稿的上传可恢复，已公开版本不会覆盖，须发布新版本。

本流程也支持推送与 package.json 一致的 v* 标签，以及 Actions → Release desktop and package → Run workflow。已有公开版本会跳过；普通代码提交而未升级版本号不会重复发布。带 -beta.1 等后缀的版本发布为 prerelease 与 npm next 标签。

## GitHub 权限与首次包发布

工作流使用仓库临时 GITHUB_TOKEN 的 contents:write 与 packages:write 权限，不需要在源码或仓库密钥中配置个人令牌。源仓库保持 private:true，专用生成目录显式只打包 Windows ZIP、包说明和第三方声明，防止误发布开发资料。

当前包已验证无需登录即可查看公开页面。GitHub 包的可见性与仓库权限分别管理；若以后改名创建新包而默认成为 Private，在 Package settings → Change visibility 将其设为 Public，后续版本沿用该包设置。若首次尚未设为公开，Release 的 ZIP 和 TGZ 下载仍然可用。[GitHub 包权限说明](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

GitHub npm 单版本压缩包必须小于 256 MB。若未来完整 Windows 包超过上限，需调整分发形式，流程会明确失败，不发布空壳占位包。
