# 开发与发布

这份文档写给想改 Seed 本身、或者要发布新版本的人。只是使用的话，看 [README](../README.md) 就够了。

## 从源码运行

需要 Node.js 22 或更高版本。

```bash
npm install
```

以桌面应用方式运行：

```bash
npm run desktop
```

以本地网页服务方式运行（在浏览器里用）：

```bash
npm start
```

终端会打印一个带访问令牌的地址，用浏览器打开它：

```
  Open        http://127.0.0.1:7333/?token=…
```

只用命令行版、不需要桌面版时，可以用 `npm install --omit=dev` 跳过 Electron 的下载。想装成全局命令：

```bash
npm link
```

之后在任意项目目录里运行 `seed`，那个目录就是工作目录。

没有构建步骤，改了代码重启即可。唯一的运行时依赖是 `@anthropic-ai/sdk`（桌面版另外用到 Electron）。

## 项目结构

```
bin/seed.js            命令行入口
desktop/main.js        桌面应用（Electron）：窗口、菜单、系统代理
build/                 应用图标、macOS 签名配置
electron-builder.config.cjs   打包配置
.github/workflows/     三平台测试（ci.yml）、构建并发布安装包（release.yml）
src/
  app.js               把各部分组装起来
  agent/               智能体循环、审批策略、系统提示词、上下文整理
  providers/           模型接口适配：openai.js（兼容协议）、anthropic.js（官方 SDK）
  tools/               内置工具
  extensions/host.js   扩展加载、热重载、错误收集
  server/              HTTP 服务、REST API、OpenAI 兼容端点、鉴权
web/                   界面（原生 JavaScript，无构建步骤）
docs/                  API.md、EXTENDING.md、ARCHITECTURE.md、DEVELOPMENT.md
examples/extensions/   示例扩展
scripts/               生成 README 配图、生成发布说明的脚本
test/                  自动化测试
```

设计思路见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 测试

```bash
npm test                 # 工具、审批策略、智能体循环、两种模型接口、HTTP API、扩展系统
node test/e2e/ui.mjs     # 浏览器端到端测试（需要另装 Playwright）
node test/e2e/desktop.mjs   # 桌面应用冒烟测试（需要 Playwright；加 --app <路径> 测试打包好的应用）
```

测试用脚本化的假模型服务（按 OpenAI 和 Anthropic 的线上协议应答）驱动真实的智能体循环和真实的界面。

## 发布新版本

安装包由 GitHub Actions 在真实的 macOS、Windows、Linux 机器上构建。发布新版本最简单的方式是在网页上点一下：

1. 打开仓库的 **Actions** 页面，左侧选 **Release**。
2. 点右侧的 **Run workflow**，在 version 里填版本号（例如 `0.2.0`），点绿色的 **Run workflow**。

大约 15 到 20 分钟后，[Releases](https://github.com/HolyGr41L1337/Seed/releases) 页面会出现 `v0.2.0`，附带各个系统的安装包，说明的开头是一张“哪个系统下载哪个文件”的表格（由 `scripts/release-notes.sh` 生成）。每个安装包在发布前都会被实际启动一遍，跑一次完整的对话流程来检查。version 留空则只构建、不发布，构建好的文件可以在这次运行的页面底部下载。

也可以在自己电脑上推送标签来发布，效果一样：

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

在自己电脑上打包：

```bash
npm run dist:mac
```

（Windows 上用 `npm run dist:win`，Linux 上用 `npm run dist:linux`，产物在 `dist/` 里。）

**谁能下载。** 仓库是私有的时候，Releases 里的文件也只有对仓库有权限的人能下载。要让任何人都能下载，可以把仓库改为公开，或者另建一个公开仓库专门放安装包。

### 给安装包签名

没有签名的安装包第一次打开时会被系统拦一下（见 README 的“下载安装”）。想让用户完全看不到这些提示，在仓库的 Settings → Secrets and variables → Actions 里加上这些密钥，之后发布的安装包会自动签名：

| 密钥 | 内容 | 用途 |
| --- | --- | --- |
| `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` | Apple “Developer ID Application” 证书（.p12，base64 编码）及其密码 | macOS 签名（需要 Apple 开发者账号，每年 99 美元） |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple ID、App 专用密码、团队 ID | macOS 公证，之后双击即可打开 |
| `WIN_CERT_PFX_BASE64` / `WIN_CERT_PASSWORD` | Windows 代码签名证书（.pfx，base64 编码）及其密码 | Windows 签名 |

## README 和配图

README 有五种语言：`README.md`（中文）、`README.en.md`、`README.ja.md`、`README.fr.md`、`README.ru.md`。改内容时五个文件要一起改。

README 里的演示动图、截图、徽章和下载按钮都由一个脚本生成，界面改动之后重新跑一遍即可：

```bash
node scripts/readme-media.mjs
```

需要 Playwright（带 Chromium）和 ffmpeg。图片输出到 `docs/images/`，中文界面和英文界面、浅色和深色各一套；日语、法语、俄语的 README 用英文界面的图。动图里的应用是真实的，模型是脚本化的替身，“写出来”的侧边栏就是 `examples/extensions/history-sidebar`。
