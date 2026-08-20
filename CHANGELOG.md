# Changelog / 更新日志

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

- Initial independent Agent Status release extracted from Notifyer.
- Agent Status 从 Notifyer 中拆分并首次独立发布。
- Codex and Claude credentials and quota requests run directly in the current local, Remote SSH, WSL, or Dev Container workspace environment.
- Codex 与 Claude 凭据和额度请求直接运行在当前本地、Remote SSH、WSL 或 Dev Container 工作区环境中。
- Added compact quota status, detailed hover information, refresh animations, remaining/used modes, startup retries, diagnostics, and legacy Notifyer quota-setting fallback.
- 支持紧凑额度状态、完整悬浮说明、刷新动画、剩余/已使用模式、启动重试、诊断，以及旧版 Notifyer 额度配置兼容读取。
