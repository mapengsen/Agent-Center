# Changelog / 更新日志

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
