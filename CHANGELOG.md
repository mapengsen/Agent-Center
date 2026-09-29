# Changelog / 更新日志

## 0.1.6 - 2026-09-29

### Fixed / 修复

- Fixed the missing recovery path when Codex successfully opens PDF/SVG as text and emits no failure log. Clean text tabs for the same file are closed before `code -r`, allowing the default viewer to open.
- 修复 Codex 将 PDF/SVG 成功打开为文本、没有失败日志时无法触发补开的问题。先关闭同一文件未修改的文本标签页，再执行 `code -r`，交给默认查看器。
- Added `agentStatus.codexImageLinks.reopenTextDocuments` (default on). It applies to PDF/SVG text tabs from all sources, because VS Code does not expose the opener. Disable it for source editing. Unsaved edits, custom viewers, and diff editors are preserved; fallback text tabs are not repeatedly reopened.
- 新增默认启用的 `agentStatus.codexImageLinks.reopenTextDocuments`。由于 VS Code 不暴露打开来源，该设置适用于所有 PDF/SVG 文本标签页；编辑源码时可关闭。保留未保存修改、已有预览和差异编辑器，并防止反复重开。
- Recent in-memory diagnostics now distinguish `text-editor` events from `codex-log` events.
- 内存中的最近诊断现在区分 `text-editor` 与 `codex-log` 事件来源。

## 0.1.5 - 2026-09-29

### Changed / 变更

- Recovery now runs `code -r` via the current installation's bundled CLI instead of the `vscode.open` API. Paths are passed as literal arguments without a command shell, and remote sessions use their extension host's CLI connection.
- 补开方式由 `vscode.open` API 改为运行当前安装自带 CLI 的 `code -r`；路径作为独立参数传入，远程会话使用对应扩展宿主的 CLI 连接。
- Added PDF and SVG recovery, a process timeout, and CLI failure diagnostics. PDF rendering depends on the installed viewer; SVG follows the default editor configuration.
- 新增 PDF、SVG 补开、进程超时限制及 CLI 失败诊断。PDF 预览依赖已安装的查看器，SVG 按默认编辑器配置打开。

## 0.1.4 - 2026-09-29

### Added / 新增

- Added experimental recovery for supported absolute image links that Codex fails to open, enabled by default. Uses `vscode.open` without modifying Codex or requiring custom links.
- 新增 Codex 图片绝对路径链接打开失败后自动补开的实验功能，默认启用；使用 `vscode.open`，无需修改 Codex 或使用专用链接。
- Reads only new failure records from the current window and extension host's existing Codex log, with bounded reads, rotation handling, duplicate suppression, and focus/trust checks.
- 只读取当前窗口、当前扩展宿主既有 Codex 日志中的新增失败记录，支持读取量限制、日志轮转、去重及窗口焦点与工作区信任检查。
- Added settings, a restart command, and up to 40 recent recovery results held in memory and exposed through Show Diagnostics. Does not create an additional log file.
- 新增配置开关、重启监听命令及 Show Diagnostics 中的补开结果；最多在内存保留最近 40 条记录，不额外创建日志文件。

## 0.1.3 - 2026-08-24

### Changed / 变更

- Replaced monochrome Codicons in hover details with a distinct set of colorful emoji markers and added usage-sensitive green, yellow, orange, and red percentage indicators.
- 将悬浮详情中的单色 Codicon 替换为一套独立的彩色 Emoji，并根据已使用比例增加绿、黄、橙、红动态百分比标记。

## 0.1.2 - 2026-08-24

### Changed / 变更

- Renamed the visible extension brand to Agent Center while preserving the existing Marketplace extension ID and `agentStatus.*` settings.
- 插件展示品牌改为 Agent Center，同时保留现有 Marketplace 扩展 ID 和 `agentStatus.*` 设置。
- Added Codicon section markers for status meaning, account, plan, usage windows, last update, and hover actions.
- 为悬浮详情中的状态栏含义、账户、套餐、额度窗口、最后更新时间和操作入口增加 Codicon 图标。
- Moved repository metadata and documentation links to `mapengsen/Agent-Center`.
- 仓库元数据和文档链接迁移至 `mapengsen/Agent-Center`。
- Corrected the Open Settings command to target the stable extension ID `pengsen.codex-claude-agent-status`.
- 修正“打开设置”命令，使其指向稳定扩展 ID `pengsen.codex-claude-agent-status`。

## 0.1.1 - 2026-08-20

### Changed / 变更

- Automatic refreshes no longer show the spinning refresh indicator; it is reserved for manual refreshes.
- 自动刷新不再显示旋转刷新动画，仅手动刷新时显示。
- Startup cadence is now an immediate refresh followed by three automatic refreshes at 60-second intervals.
- 启动阶段改为立即刷新一次，随后每 60 秒自动刷新一次，共 3 次。
- Regular refreshes default to every 15 minutes; failures retry every 30 seconds, up to five attempts per cycle.
- 常规刷新默认间隔改为 15 分钟；刷新失败时每 30 秒重试，单轮最多尝试 5 次。

## 0.1.0 - 2026-08-19

### Added / 新增

- Initial independent release extracted from Notifyer.
- 从 Notifyer 中拆分并首次独立发布。
- Codex and Claude credentials and quota requests run directly in the current local, Remote SSH, WSL, or Dev Container workspace environment.
- Codex 与 Claude 凭据和额度请求直接运行在当前本地、Remote SSH、WSL 或 Dev Container 工作区环境中。
- Added compact quota status, detailed hover information, refresh animations, remaining/used modes, startup retries, diagnostics, and legacy Notifyer quota-setting fallback.
- 支持紧凑额度状态、完整悬浮说明、刷新动画、剩余/已使用模式、启动重试、诊断，以及旧版 Notifyer 额度配置兼容读取。
