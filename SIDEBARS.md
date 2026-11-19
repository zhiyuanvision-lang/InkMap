# Inkmap 多平台安装与验收

VS Code、Cursor、Codex、DeepSeek Harness 和 WorkBuddy 共用 Inkmap 编辑器。导图节点和 Mermaid 源码仍保存在 Markdown 中。新增 TRAE、Qoder CN IDE 或 ZCode 时，可先复用下面的安装包，验证宿主的文件与界面能力。

## 构建

在 Inkmap 仓库根目录运行（需要 Node.js 22 或更新版本，以及 `zip` 和 `unzip`）：

```sh
npm ci
npm run package:platforms
npm run test:sidebars
```

| 接入方式 | 安装包 |
| --- | --- |
| VS Code 兼容扩展 | `packages/vscode/dist/inkmap.vsix` |
| 本机浏览器侧栏 | `dist/sidebars/inkmap-local-editor.zip` |
| DeepSeek Harness 原生入口 | `dist/sidebars/dsh-inkmap-<版本号>.tgz` |
| Codex 桌面文件查看器 | `dist/sidebars/inkmap-codex-desktop.zip` |
| WorkBuddy 自定义菜单 | `dist/sidebars/inkmap-workbuddy.zip` |
| Qoder 桌面端对话插件 | `dist/sidebars/inkmap-qoder-0.1.0.zip` |
| Antigravity 2.0 MCP App 插件 | `dist/sidebars/inkmap-antigravity-0.2.0.zip` |

`<版本号>` 与 `packages/cli/package.json` 的 `version` 相同；Qoder 与 Antigravity 的 ZIP 文件名取自各自 `plugin.json` 中的版本号。

## Google Antigravity 2.0

解压 `inkmap-antigravity-0.2.0.zip`，在解压后的目录运行 `node install.mjs`（安装到 `~/.gemini/config/plugins/inkmap`）。只构建该插件可运行 `npm run package:antigravity`。

安装后支持以下打开与交互方式：
1. **AI 自动弹出**：在对话中请 AI 用 Inkmap 打开指定 Markdown 文件，AI 调用 `inkmap_open` 工具后，右侧辅助面板会自动展开或刷新对应思维导图。
2. **界面直接点开**：点击右侧辅助面板顶部 `+` 按钮选择 **Inkmap**（或点击左侧边栏 **Inkmap**），从导图工具栏左侧下拉框切换当前工作区或已注册项目中的 `.markmap.md` / `.md` 文件；点击「左MD/右导图」可开启源码与导图同屏对比编辑，点击「原文件」可在右侧并排打开原生文件视图。
3. **节点发送到对话**：选中导图节点后点击「发送到对话」，可将对应 Markdown 片段作为上下文胶囊附加到当前会话输入框。

## Qoder 桌面端

在「扩展 → 插件 → 添加插件 → 上传 Plugin」选择 `inkmap-qoder-0.1.0.zip`。在本地工作区的新任务里输入 `/inkmap`，从候选列表选择 Inkmap（可能显示为 `inkmap:inkmap`），再用 `@` 引用一份 Markdown 文件并发送。

把 Inkmap 给出的命令粘贴到该工作区的 Qoder 终端。需要 Node.js 22 或更新版本。将终端显示的地址粘贴到右侧「添加标签页 → 打开内置浏览器」。导图修改保存回原 Markdown，结束时在终端按 Ctrl+C。插件从对话调用，右侧通过内置浏览器显示编辑器。

只构建该插件可运行 `npm run package:qoder`。公开发布从 [Qoder CN 能力市场](https://qoder.cn/marketplace) 的「提交到社区」进入登录后的发布页。试装 ZIP 可用于本地验收，公开上架以发布页支持的材料和平台审核结果为准。

## TRAE 中国版和 Qoder CN IDE

1. 用两端各自的扩展视图安装同一份 `inkmap.vsix`。TRAE 在扩展视图菜单选择「从 VSIX 安装」；Qoder CN IDE 请使用扩展视图的本地安装入口（如当前版本提供）。
2. 打开工作区里的 Markdown 文件，在文件右键菜单选择「Open as Inkmap」，或在命令面板搜索 Inkmap 的侧边打开命令。
3. 修改一个导图节点后，检查 Markdown 编辑器中的内容，再保存文件。随后从文本编辑器修改并保存，检查导图是否刷新。

安装包要求 VS Code 兼容 API 版本至少为 1.90。两端目前是兼容测试目标，安装、激活和文件写回还需在各自的桌面客户端验收。若 VSIX 无法运行，可用下面的本机浏览器方式。参见 [TRAE 扩展安装](https://docs.trae.cn/ide_manage-extensions) 和 [Qoder CN IDE 扩展文档](https://docs.qoder.cn/getting-started/qodercn-ide-get-started)。

## Codex 桌面版

解压 `inkmap-codex-desktop.zip`，在解压后的文件夹中运行 `node install.mjs`。完全退出并重启 ChatGPT 桌面应用，在 Codex 模式下打开本地项目的 Markdown 文件，从文件打开菜单选择 **Inkmap Mind Map**。安装和更新步骤见 [Codex 桌面版安装说明](packages/codex/README.md)。

维护者可用 `npm run package:codex` 单独生成 ZIP。开发时也可以直接安装构建目录中的插件：

```sh
codex plugin marketplace add ./dist/sidebars
codex plugin add inkmap-codex@inkmap-local
```

更新构建后重新执行第二条命令刷新已安装副本。支持写入的文件会自动保存。如果宿主没有给出可写权限和版本，Inkmap 以只读方式打开。文件冲突时加载最新版本并提示重做本次修改。

如果右侧显示「未能显示 Inkmap Mind Map」，且桌面日志出现 `unknown MCP server 'inkmap'`，说明当前会话没有加载 Inkmap 服务。可在同一项目的新会话中打开原文件。如果需要继续使用原会话，请完全退出并重启桌面端，再进入原会话打开文件。

在 Codex 中可登录云帆账号恢复已有权益。导图由宿主文件接口传给侧栏，收费服务只检查权益。用户可通过自定义插件源安装，并在 Codex 桌面端使用右侧文件查看器。只有向 OpenAI 官方插件目录提交本机 MCP 插件时，才需要合作伙伴准入。参见 [自定义插件源](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)、[文件入口](https://developers.openai.com/plugins/build/extensions#file-viewers-and-editors) 和 [桌面插件发布要求](https://developers.openai.com/plugins/deploy/desktop-only)。

## DeepSeek Harness 插件

在 DeepSeek Harness Desktop **0.2.2-rc.2** 的「插件 → 添加插件」中，输入构建后 `dsh-inkmap-<版本号>.tgz` 的绝对路径并安装。打开本机工作区内的 Markdown 文件预览，点击工具栏中的「Inkmap」。空间足够时，Markdown 在左、导图在右。拖动分隔线可调整宽度，关闭左边的 Markdown 标签可单独查看导图。导图修改写回原文件，同一会话中重复打开同一文件会定位到已有导图标签。

支持本机工作区内 5 MiB 以内的 Markdown。点击导图工具栏的「登录」可在浏览器连接账号，已有 Pro 权益会自动同步。关闭导图标签或停用插件会释放对应的本机编辑会话。以下命令也可将包安装到已有的本机 Web profile 中，重启该 profile 后使用。

```sh
dsh plugin --profile web add "/绝对路径/dsh-inkmap-<版本号>.tgz"
```

## 本机浏览器侧栏（DeepSeek Harness 和 ZCode）

```sh
node "/解压目录/inkmap-local-editor/inkmap.mjs" "/绝对路径/文件.markmap.md" --sidebar
```

安装 Node.js 22 或更新版本，然后解压安装包并运行上述命令。打开 Harness 的右侧「浏览器」标签，或 ZCode 桌面版的内置浏览器，将终端打印的本机地址粘贴到地址栏。保持终端运行，编辑会写回原文件；其他编辑器保存时导图会刷新。地址包含本次编辑的访问凭证，只用于本机浏览器。退出终端中的服务后地址失效。也可以直接在系统浏览器打开该地址。

支持使用同一云帆账号恢复权益，复用 CLI 的本机登录和试用记录。ZCode 路径复用本机浏览器服务，仍需在其桌面客户端验收。参见 [Harness 侧栏浏览器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-browser/README.md) 和 [ZCode 内置浏览器](https://zcode.z.ai/cn/docs/ADE-tools)。

发行渠道允许外部结账时，可在命令末尾加 `--sidebar-purchase`。购买入口打开云帆平台结账页，默认侧栏仍提供账号恢复。

## WorkBuddy

在 [Buddy 应用开放平台](https://open.workbuddy.cn/en/docs/buddy-app) 的网页包配置中上传 `inkmap-workbuddy.zip`，选择 `inkmap` 页面，填写侧栏菜单中英文名称，然后用平台生成的预览链接验证。

在侧栏中用「打开 Markdown」选择文件。网页宿主能授予本机文件句柄时可写回；嵌入宿主仅提供普通文件选择器时，状态会显示「已更新副本」，请用「下载 Markdown」保留改动。

网页包默认使用本地试用。启用云帆会员恢复需要在 WorkBuddy 预览中确认页面拥有专属 HTTPS Origin，再把该地址加入 ZhiyuanPlatform 收费服务的 `BILLING_BROWSER_RESTORE_ORIGINS`。同时在 Buddy 应用的可信 Origin 中添加收费服务地址，并用 `VITE_INKMAP_BROWSER_RESTORE_ORIGIN=https://zhiyuanv.com npm run build:sidebars` 重建网页包。不要为共享或 `null` Origin 开启浏览器账号恢复。生产服务尚未开启此配置，网页包也未提交审核。

## 接入和验收新平台

优先选择上表中已有的入口。需要新增适配时，在 `Host` 中实现加载、版本化保存和外部更新；通过 `capabilities` 声明保存目标、账号操作、紧凑界面和资源限制。只能保存副本的宿主提供下载；缺少可写权限或文件版本时，文档以只读方式打开。宿主提供发送到对话的能力时才启用该入口。

用包含嵌套列表和 Mermaid 的 Markdown 验收打开、编辑写回、外部修改刷新、并发冲突和已有 Pro 恢复。记录实际验收的宿主版本、操作系统和安装来源；商店上架与实机兼容分别确认。
