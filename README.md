# Seed

**只有一个输入栏的 AI 智能体工具。其余的功能，让 AI 来做。**

Seed 是一个类似 Codex、DeepSeek Harness 的智能体运行框架（harness）：接上你自己的模型 API，它就能在你的电脑上读写文件、运行命令、搜索代码、完成任务。不同的地方在于，它的界面一开始只有一个新建对话栏。历史侧边栏、设置页、主题、新工具、各种集成，都不内置，你用一句话让 AI 给软件本身加上，页面当场长出来，不用重启。

![首页：只有一个输入栏](docs/images/home.png)

对它说"给这个软件加一个历史对话侧边栏"之后：

![AI 写了一个扩展，页面长出了侧边栏](docs/images/grown.png)

## 能做什么

- **智能体**：流式对话、思考过程、工具调用（命令行、读写改文件、目录、glob、grep、抓取网页、任务计划）、逐项审批、随时停止、长对话自动整理上下文、读取工作目录里的 `AGENTS.md`。
- **自我生长**：AI 把新功能写成扩展（纯 JavaScript 文件），保存即热加载。加载出错时，带文件名和行号的报错会直接回给 AI，它自己改到好为止。扩展可以加界面（侧边栏、面板、按钮、整页视图、斜杠命令、快捷键），也可以加后端能力（给 AI 用的新工具、HTTP 接口、钩子、定时任务、新的模型接口类型）。
- **接你自己的 API**：DeepSeek、OpenAI、OpenRouter、Ollama 以及任何 OpenAI 兼容接口；Claude 走 Anthropic 官方 SDK。可以配多家，随时切换，同一个对话中途换模型也行。
- **别的程序也能接它**：全部功能都有 HTTP API。另有一个 OpenAI 兼容端点，把任何支持 OpenAI 接口的客户端指向 Seed，就能把整个智能体当成一个"模型"来用。

## 下载安装

到仓库的 [Releases](https://github.com/HolyGr41L1337/Seed/releases/latest) 页面下载对应的文件：

| 系统 | 下载 | 用法 |
| --- | --- | --- |
| macOS（Apple 芯片：M1/M2/M3/M4…） | `Seed-<版本>-mac-arm64.dmg` | 打开后把 Seed 拖进"应用程序" |
| macOS（Intel 芯片） | `Seed-<版本>-mac-x64.dmg` | 同上 |
| Windows（绝大多数电脑） | `Seed-Setup-<版本>-x64.exe` | 双击安装，装完自动打开，不需要管理员权限 |
| Windows（免安装） | `Seed-<版本>-win-x64.zip` | 解压后双击 `Seed.exe` |
| Windows（ARM 电脑） | `Seed-Setup-<版本>-arm64.exe` | 同上 |
| Linux | `Seed-<版本>-linux-x86_64.AppImage` | 加上执行权限后双击 |

不知道 Mac 是哪种芯片：点左上角苹果菜单 →"关于本机"，"芯片"一栏写着 Apple M… 的选 arm64，写着 Intel 的选 x64。

打开后是一个只有输入栏的窗口，下方有"连接模型 API"的卡片：选服务商，填 API Key，点连接，就可以开始用了。

### 第一次打开时的系统提示

目前的安装包没有经过苹果和微软的付费签名，所以第一次打开时系统会拦一下。这是所有未签名软件都会遇到的情况，按下面操作一次即可，以后正常打开。

- **macOS**：双击后如果提示"无法验证开发者"或"Apple 无法检查其是否包含恶意软件"，先点"完成"关掉提示，然后打开"系统设置 → 隐私与安全性"，在页面下方找到关于 Seed 的提示，点"仍要打开"。也可以在"终端"里运行一次：

  ```bash
  xattr -dr com.apple.quarantine /Applications/Seed.app
  ```

- **Windows**：如果出现"Windows 已保护你的电脑"，点"更多信息"，再点"仍要运行"。

想让用户完全看不到这些提示，需要购买签名证书，见下文"发布新版本"。

### 桌面版的几个菜单

- **文件 → 选择工作目录…**（`Cmd/Ctrl+O`）：AI 读写文件、运行命令所在的文件夹。默认是你的用户主目录，建议选到具体项目。
- **文件 → 复制 API 接入信息**：复制本机 API 地址和访问令牌，给别的程序接入用（见"通过 API 接入"）。
- **视图 → 安全模式**：某个扩展把界面弄坏时，用它打开一个不加载界面扩展的窗口。

桌面版会自动使用系统的代理设置（例如代理工具开启的系统代理），访问 OpenAI、Anthropic 等服务时不需要额外配置。macOS 上关闭窗口后应用仍在后台运行（API 也继续可用），从程序坞点它会重新打开窗口；完全退出用 `Cmd+Q`。

桌面版和命令行版共用同一份数据（`~/.seed`），对话、设置和扩展是通用的。

## 从源码运行（开发者）

需要 Node.js 22 或更高版本。

```bash
cd seed
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

## 连接模型 API

在界面里连接最简单（随时输入 `/connect` 可以再打开）。也可以在启动前设置环境变量，Seed 会自动识别：

| 环境变量 | 服务商 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude（Anthropic） |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `OPENAI_API_KEY`（可配 `OPENAI_BASE_URL`） | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |

其他服务商在连接卡片里选"自定义（OpenAI 兼容）"或"自定义（Anthropic 兼容）"，填接口地址、Key 和模型名即可。

配置保存在 `~/.seed/config.json`（权限 600，Key 只存在本机）。一个服务商的完整写法：

```json
{
  "providers": {
    "deepseek": {
      "type": "openai",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "$DEEPSEEK_API_KEY",
      "params": { "max_tokens": 8192 },
      "contextWindow": 128000
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

- `apiKey` 可以直接写 Key，也可以写 `"$环境变量名"`，这样 Key 不落盘。
- `params` 会原样并入每次请求，服务商特有的开关（`temperature`、`reasoning_effort`、DeepSeek 的 `thinking` 等）都写在这里。
- `contextWindow` 是模型的上下文长度。对话接近这个长度时，Seed 会让模型把前文整理成摘要再继续。
- DeepSeek 等模型在思考模式下要求把之前的 `reasoning_content` 回传，Seed 会自动处理；遇到不允许回传的接口也会自动切换。
- Claude 使用官方 SDK，默认模型是 `claude-opus-5-5`，开启自适应思考和提示缓存。对于支持的模型，还默认开启了**服务端兜底**（请求被安全分类器误拦时，由 Anthropic 推荐的另一个模型接着回答）。不想要的话，在该服务商的 `params` 里加 `"fallbacks": false`。`params` 里还可以设 `effort`（`low` 到 `max`）和 `maxTokens`。
- 需要走代理时，照常设置 `HTTPS_PROXY`，Seed 会遵守。

切换模型：输入 `/model` 从列表里选，或 `/model deepseek/deepseek-reasoner`。

## 让 AI 给软件加功能

直接说就行：

- "给这个软件加一个历史对话侧边栏"
- "加一个设置页面，可以切换模型和审批模式"
- "加一个深色/浅色主题切换按钮"
- "给你自己加一个查天气的工具"
- "每条回答下面加一个朗读按钮"

AI 会先读 [docs/EXTENDING.md](docs/EXTENDING.md)，在 `~/.seed/extensions/<名字>/` 下写出扩展，调用 `reload_extensions` 检查加载结果，再用 `ui_eval` 看一眼真实页面，确认没问题后告诉你怎么用。

- 输入 `/extensions` 可以查看、停用、删除扩展。
- 如果某个扩展把界面弄坏了，输入 `/safe`（或在地址后加 `?safe=1`）可以不加载界面扩展打开页面，再让 AI 修。`seed --safe` 则是完全不加载任何扩展启动。
- [examples/extensions/](examples/extensions/) 里有三个完整示例：历史侧边栏、主题切换、跨对话记忆。想直接用，把文件夹复制到 `~/.seed/extensions/` 即可。

扩展代码拥有完整权限（界面扩展能调用全部 API，后端扩展能做 Node.js 能做的一切），所以写扩展文件属于单独的审批类别，除"完全放行"模式外都会先问你。

## 审批模式

AI 要做有影响的事情之前会先问你，卡片上有"允许""本对话始终允许此类操作""拒绝"三个选项。

![修改文件前先给你看改动](docs/images/approval.png)

| 模式 | 行为 |
| --- | --- |
| `ask`（默认） | 读工作目录里的文件不用问；运行命令、改文件、访问网络、改软件设置都要你同意。少数只读命令（`ls`、`cat`、`git status` 等）直接放行。 |
| `auto-edit` | 工作目录内的文件修改自动放行，其余同上。 |
| `full` | 全部放行。 |

用 `/mode` 切换。拒绝之后 AI 会停下来等你的指示，不会绕路重试。

## 通过 API 接入

访问令牌在启动时打印，也可以随时运行 `seed url` 查看。

**当成 OpenAI 接口来用**（接口地址填 `http://127.0.0.1:7333/v1`，API Key 填访问令牌，模型填 `seed`）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:7333/v1", api_key="<访问令牌>")
reply = client.chat.completions.create(
    model="seed",
    messages=[{"role": "user", "content": "这个仓库里有哪些 TODO？"}],
)
print(reply.choices[0].message.content)
```

这样接入时没有人能点审批，所以默认只允许读取；要让它动手，请求里加请求头 `x-seed-approval: auto-edit` 或 `full`。

**一次调用完成一个任务**：

```bash
curl http://127.0.0.1:7333/api/chat \
  -H "Authorization: Bearer <访问令牌>" -H "Content-Type: application/json" \
  -d '{"message": "运行测试并总结失败原因", "approval": "full"}'
```

加上 `"stream": true` 可以拿到实时事件流。对话管理、审批、设置、扩展、事件订阅等全部接口见 [docs/API.md](docs/API.md)。

## 命令

输入栏里输入 `/` 会弹出命令菜单：

| 命令 | 作用 |
| --- | --- |
| `/new` | 开始新对话 |
| `/connect` | 连接或更换模型 API |
| `/model [服务商/模型]` | 查看或切换模型 |
| `/mode [ask\|auto-edit\|full]` | 切换审批模式 |
| `/cd <目录>` | 切换工作目录 |
| `/compact` | 把较早的对话整理成摘要 |
| `/extensions` | 查看和管理扩展 |
| `/stop` | 停止当前任务 |
| `/safe` | 以安全模式重新打开页面 |
| `/help` | 查看全部命令（包括扩展添加的） |

命令行：

```bash
seed                        # 启动（界面 + API）
seed --port 8080 --cwd ~/code/app
seed exec "修复失败的测试"     # 不开界面，在终端里跑一个任务
seed exec --approval full --json "…"   # 适合脚本：全部放行，逐行输出 JSON 事件
seed url                    # 打印带令牌的地址
seed --safe                 # 不加载扩展启动
```

## 发布新版本

安装包由 GitHub Actions 在真实的 macOS、Windows、Linux 机器上构建。发布新版本最简单的方式是在网页上点一下：

1. 打开仓库的 **Actions** 页面，左侧选 **Release**。
2. 点右侧的 **Run workflow**，在 version 里填版本号（例如 `0.2.0`），点绿色的 **Run workflow**。

大约 15 到 20 分钟后，[Releases](https://github.com/HolyGr41L1337/Seed/releases) 页面会出现 `v0.2.0`，附带上面表格里的所有文件。每个安装包在发布前都会被实际启动一遍，跑一次完整的对话流程来检查。version 留空则只构建、不发布，构建好的文件可以在这次运行的页面底部下载。

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

**谁能下载。** 仓库是私有的，Releases 里的文件也只有对仓库有权限的人能下载。要让任何人都能下载，可以把仓库改为公开，或者另建一个公开仓库专门放安装包。

**去掉"未验证开发者"提示。** 在仓库的 Settings → Secrets and variables → Actions 里加上这些密钥，之后发布的安装包会自动签名：

| 密钥 | 内容 | 用途 |
| --- | --- | --- |
| `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` | Apple "Developer ID Application" 证书（.p12，base64 编码）及其密码 | macOS 签名（需要 Apple 开发者账号，每年 99 美元） |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple ID、App 专用密码、团队 ID | macOS 公证，之后双击即可打开 |
| `WIN_CERT_PFX_BASE64` / `WIN_CERT_PASSWORD` | Windows 代码签名证书（.pfx，base64 编码）及其密码 | Windows 签名 |

## 安全须知

- 服务默认只监听本机（`127.0.0.1`）。所有接口都需要访问令牌；浏览器端的登录状态只对 Seed 自己的页面有效，其他网页无法借用。页面被嵌在 IDE 或云端的预览面板里、Cookie 用不了时，会自动改用令牌登录。
- **没有操作系统级沙箱。** 安全靠审批：默认模式下，命令和修改都要你点头。`full` 模式等于把电脑交给模型，请只在你信任任务内容的时候使用。
- 文件工具不会打开 `~/.seed/config.json`（里面有你的 Key）；接口返回的设置里也不含 Key。
- 模型输出按不可信内容处理：界面不渲染其中的 HTML，不自动加载远程图片，只有 http(s) 和 mailto 链接可点击。
- 用 `--host 0.0.0.0` 对外开放时，令牌就是唯一的门锁，请自行加上 HTTPS 和防火墙。

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
docs/                  API.md、EXTENDING.md、ARCHITECTURE.md
examples/extensions/   示例扩展
test/                  自动化测试
```

唯一的运行时依赖是 `@anthropic-ai/sdk`（桌面版另外用到 Electron）。没有构建步骤，改了代码重启即可。设计思路见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 测试

```bash
npm test                 # 工具、审批策略、智能体循环、两种模型接口、HTTP API、扩展系统
node test/e2e/ui.mjs     # 浏览器端到端测试（需要另装 Playwright）
node test/e2e/desktop.mjs   # 桌面应用冒烟测试（需要 Playwright；加 --app <路径> 测试打包好的应用）
```

测试用脚本化的假模型服务（按 OpenAI 和 Anthropic 的线上协议应答）驱动真实的智能体循环和真实的界面。

## 目前的局限

- 模型接口是按公开协议实现、用假服务验证的，开发环境里没有真实的 API Key，**尚未对真实的 DeepSeek / OpenAI / Anthropic 接口做过联调**。首次接入如果遇到某家接口的特殊要求，通常在该服务商的 `params` 里调整即可。
- 没有系统级沙箱（见上）。
- 还没有内置 MCP、网页搜索、图片上传界面（API 已支持图片内容块）。这些都可以让 AI 以扩展的形式加上。
- 自动化测试和桌面应用冒烟测试在 Linux、macOS、Windows 上运行（GitHub Actions），但还没有在真人使用的 Mac 和 Windows 电脑上长期使用过。
