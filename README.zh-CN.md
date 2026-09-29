# Agent Center

语言：<a href="https://github.com/mapengsen/Agent-Center/tree/main">English（默认）</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center 用于将 AI 编码 Agent 的信息与实用功能集中到 VS Code 中，支持在状态栏显示 Codex 和 Claude 的使用额度，以及辅助打开 Codex 对话中的图片链接。

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
- Codex 图片链接打开失败时自动补开（实验功能，默认启用）。

![Agent Center 状态栏预览](image.png)

## 打开 Codex 对话中的图片

更新 Agent Center 并重新加载 VS Code 窗口后，直接点击 Codex 对话中原有的图片绝对路径链接。如果 Codex 记录了受支持的打开失败日志，Agent Center 会将图片打开为普通编辑器标签页。无需专用链接，也无需修改 Codex。支持 PNG、JPEG、GIF、WebP、BMP 和 ICO。

使用 Remote SSH、WSL 或开发容器时，将 Agent Center 安装到 Codex 处理该文件的工作区环境中。两个扩展必须位于同一窗口、同一扩展宿主；此功能不会将远程路径转换为 Windows 本地路径。如果安装过单独的实验扩展 **Codex Image Opener**，请先禁用或卸载它，以免重复处理。

这是根据 Codex `26.917.62051` 中检查到的失败日志格式实现的兼容方案，并非 Codex 公开的点击事件接口。暂不处理相对路径、网页 URL、SVG 和 PDF；Codex 后续更改日志格式时可能需要适配。自动测试覆盖了日志到编辑器命令的流程，VS Code API 使用模拟对象；远程 VS Code 会话中的真实点击尚未验证。

Agent Center 只读取当前窗口原有 `Codex.log` 的新增内容，启动时跳过历史记录，仅在窗口获得焦点且工作区受信任时打开图片。它不会复制、移动或写入该日志。补开诊断只在内存中保留最近 40 条，原始日志仍由 VS Code 管理。

- `agentStatus.codexImageLinks.enabled`：启用或关闭自动补开，默认 `true`。
- **Agent Center: Show Diagnostics**：查看 `codexImageLinks.status`、识别到的日志路径和最近结果。`watching` 表示已找到日志；`waiting for Codex.log` 表示预期位置尚未出现日志。
- **Agent Center: Restart Codex Image Link Listener**：排查问题后重启监听，然后重新点击图片链接。
- `agentStatus.codexImageLinks.logFile`：高级设置，手动指定当前窗口、当前扩展宿主中的 `Codex.log` 绝对路径；留空自动定位。它指定读取来源，不会在该路径创建新日志。

## 更新日志

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
