# Agent Center

语言：<a href="https://github.com/mapengsen/Agent-Center/tree/main">English（默认）</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center 用于将 AI 编码 Agent 的信息与实用功能集中到 VS Code 中，支持在状态栏显示 Codex 和 Claude 的使用额度，以及辅助打开 Codex 对话中的文件链接。

**GitHub**: [github.com/mapengsen/Agent-Center](https://github.com/mapengsen/Agent-Center)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status)

**我的所有插件推荐：**

1. **Notifyer Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion)
2. **Agent Center**：[marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status)

## 主要功能

- 使用 `5% left | 8-20 11:24` 或 `5% used | 8-20 11:24` 这样的紧凑单行格式。
- 显示 Codex 短窗口、长窗口、账户邮箱和套餐信息。
- 显示 Claude 5 小时、7 天、Opus 与 Sonnet 窗口信息。
- 鼠标悬停信息使用按类别区分的彩色 Emoji 标记状态栏含义、账户、套餐、额度窗口、重置时间、最后更新时间和操作入口；百分比标记会随着已使用比例升高依次变为绿、黄、橙、红。（状态栏重置时间使用 Agent Center 运行环境的时区；如果远程服务器和 Windows 时区不同，显示的时钟时间也可能不同。）
- 支持剩余/已使用两种显示模式，并可点击状态栏立即刷新。
- 只有手动请求期间显示旋转的“刷新中”动画；自动刷新时保持正常状态显示。
- 启动时立即刷新，随后每 60 秒自动刷新一次，共 3 次；之后使用默认 15 分钟的常规间隔。常规阶段刷新失败时每 30 秒重试，单轮最多尝试 5 次。
- 通过 `code -r` 自动补开支持格式的 Codex 文件链接（实验功能，默认启用）。

![Agent Center 状态栏预览](image.png)

## 打开 Codex 对话中的文件

更新 Agent Center 并重新加载 VS Code 窗口后，直接点击 Codex 对话中原有的文件绝对路径链接。如果 Codex 记录了受支持的打开失败日志，Agent Center 会执行 `code -r` 打开该路径。无需专用链接，也无需修改 Codex。默认支持以下 30 种扩展名：

| 类别 | 扩展名 |
| --- | --- |
| 图片、PDF | `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.bmp`、`.ico`、`.pdf`、`.svg` |
| Markdown、文档 | `.md`、`.markdown`、`.mdx`、`.rst` |
| 表格数据 | `.csv`、`.tsv` |
| 网页 | `.html`、`.htm` |
| Notebook | `.ipynb` |
| 科研文档 | `.tex`、`.bib` |
| 配置与日志 | `.log`、`.json`、`.jsonl`、`.yaml`、`.yml`、`.toml`、`.xml` |
| Office 文档 | `.docx`、`.xlsx`、`.pptx` |

打开效果与手动执行 `code -r` 一致，由默认编辑器决定。PDF、Office 预览需要相应的查看器扩展；Markdown、CSV 和 HTML 不会被强制切换为渲染预览、表格或浏览器。

支持的文件也可能被 Codex 成功打开为纯文本，因此没有失败日志。Agent Center 会检测这种活动文本标签页，先关闭该文件未修改的文本标签页，再执行 `code -r`。这样 CLI 可以选择默认编辑器，而不是继续复用文本标签页。已有的预览、Notebook、差异对比及未保存修改会保留。监听启动时也会检查当前活动文本标签页。

VS Code 没有提供文本标签页的打开来源，因此这项检测适用于所有来源，不限 Codex。需要保留原有文本标签页时，可关闭 `agentStatus.codexImageLinks.reopenTextDocuments`，或从扩展名列表中移除特定格式。如果默认编辑器仍返回文本标签页，监听器会保留它供正常编辑，并防止重复重开，包括 CLI 启动较慢的情况。

Agent Center 在后台启动当前 VS Code 安装自带的命令行工具，将路径作为独立参数传入，不会向你的终端输入命令。远程会话沿用当前扩展宿主的 CLI 连接。Windows 上直接运行 `code.cmd` 对应的 CLI 入口，保留路径中的空格、中文和特殊字符。执行失败可在 Show Diagnostics 中查看。

使用 Remote SSH、WSL 或开发容器时，将 Agent Center 安装到 Codex 处理该文件的工作区环境中。两个扩展必须位于同一窗口、同一扩展宿主；此功能不会将远程路径转换为 Windows 本地路径。如果安装过单独的实验扩展 **Codex Image Opener**，请先禁用或卸载它，以免重复处理。

失败日志补开根据 Codex `26.917.62051` 中检查到的格式实现，并非 Codex 公开的点击事件接口；Codex 后续更改日志格式时可能需要适配。文本标签页补开独立使用 VS Code 编辑器事件，不依赖失败日志。网页 URL 和虚拟文档不处理。自动测试使用模拟 VS Code API 验证两条补开流程，并覆盖 CLI 定位和真实子进程的路径参数传递；远程 VS Code 会话中的真实点击尚未验证。

Agent Center 只读取当前窗口原有 `Codex.log` 的新增内容，启动时跳过历史记录，仅在窗口获得焦点且工作区受信任时打开文件。它不会复制、移动或写入该日志。补开诊断只在内存中保留最近 40 条，原始日志仍由 VS Code 管理。

- `agentStatus.codexImageLinks.enabled`：启用或关闭自动补开，默认 `true`。
- `agentStatus.codexImageLinks.extensions`：替换默认扩展名列表，同时控制日志与文本标签页两条补开流程。不区分大小写，可省略开头的点，归一化后去重；空列表表示不处理任何格式。
- `agentStatus.codexImageLinks.reopenTextDocuments`：补开配置列表内、任何来源的未修改文本标签页，默认 `true`；需要保留原有文本标签页时可关闭。
- **Agent Center: Show Diagnostics**：查看 `codexImageLinks.status`、`extensions`、`textEditorRecovery`、日志路径和最近结果；每条结果标明 `codex-log` 或 `text-editor` 来源。`watching` 表示已找到日志；`waiting for Codex.log` 表示预期位置尚未出现日志。等待日志时，编辑器事件补开仍可运行。
- **Agent Center: Restart Codex File Link Listener**：排查问题后重启监听，然后重新点击文件链接。
- `agentStatus.codexImageLinks.logFile`：高级设置，手动指定当前窗口、当前扩展宿主中的 `Codex.log` 绝对路径；留空自动定位。它指定读取来源，不会在该路径创建新日志。

## 更新日志

### 0.1.8 - 2026-09-30

- 从默认 `code -r` 补开格式中移除 `.txt`，其他已配置格式保持不变。

### 0.1.7 - 2026-09-29

- 将 `code -r` 补开范围扩展到 31 种格式，新增 Markdown、CSV/TSV、HTML、Notebook、LaTeX/BibTeX、普通文本与配置（含 TOML），以及 Office 文档。
- 新增两条补开流程共用的扩展名配置列表，兼容原生 Notebook 编辑器，并防止 CLI 启动较慢时重复重开文本标签页。

### 0.1.6 - 2026-09-29

- 修复 PDF/SVG 被 Codex 当作文本成功打开、没有失败日志时无法补开的问题：先关闭未修改的文本标签页，再执行 `code -r`。
- 新增独立的文本标签页补开开关、未保存修改保护、防重复重开，以及诊断事件来源标记。

### 0.1.5 - 2026-09-29

- 补开方式改为通过 VS Code 自带 CLI 执行 `code -r`，支持远程窗口连接信息传递及进程执行时限。
- 新增 PDF、SVG 链接支持，以及 CLI 执行失败诊断。

### 0.1.4 - 2026-09-29

- 新增 Codex 图片绝对路径链接自动补开功能，支持诊断查看和开关设置。
- 增量读取日志并限制读取量，支持日志轮转与重复事件去重；补开诊断仅保存在内存中。

### 0.1.3 - 2026-08-24

- 将悬浮提示中的单色 Codicon 替换为一套独立的彩色 Emoji。
- 根据已使用额度增加绿、黄、橙、红动态百分比标记。

### 0.1.2 - 2026-08-24

- 将插件展示品牌改为 Agent Center，同时保留原有 Marketplace 扩展 ID。
- 为 Codex 和 Claude 悬浮详情的各信息段落增加 Codicon 图标。
- 源代码仓库迁移到 `mapengsen/Agent-Center`。

### 0.1.1 - 2026-08-20

- 优化启动刷新、常规刷新与失败重试调度。
- 仅在手动刷新期间显示旋转刷新动画。

### 0.1.0 - 2026-08-19

- 从 Notifyer 中拆分并首次独立发布。
- Codex/Claude 凭据读取、网络请求、状态栏、悬浮说明、刷新动画和定时刷新现在全部在当前工作区环境内运行。
