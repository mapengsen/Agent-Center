# Agent Status

语言：<a href="./README.md">English（默认）</a> | <a href="./README.zh-CN.md">简体中文</a>

Agent Status 用于在 VS Code 状态栏中显示 Codex 和 Claude 的使用额度。

**GitHub**: [github.com/mapengsen/Agent-Status](https://github.com/mapengsen/Agent-Status)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.agent-status)

**我的所有插件推荐：**

1. **Notifyer Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion)
2. **Agent Status**：[marketplace.visualstudio.com/items?itemName=pengsen.agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.agent-status)

## 主要功能

- 使用 `5% left | 8-20 11:24` 或 `5% used | 8-20 11:24` 这样的紧凑单行格式。
- 显示 Codex 短窗口、长窗口、账户邮箱和套餐信息。
- 显示 Claude 5 小时、7 天、Opus 与 Sonnet 窗口信息。
- 鼠标悬停时解释百分比、当前代表的窗口、重置时间和最后更新时间(状态栏重置时间使用 Agent Status 运行环境的时区。如果远程服务器和 Windows 时区不同，显示的时钟时间也可能不同。)。
- 支持剩余/已使用两种显示模式，并可点击状态栏立即刷新。
- 启动、定时和手动请求期间显示旋转的“刷新中”动画。
- 启动时立即刷新，随后每 30 秒刷新一次，共 6 次；之后使用默认 10 分钟的常规间隔。

![alt text](image.png)

## 更新日志

### 0.1.0 - 2026-08-19

- 从 Notifyer 中拆分并首次独立发布。
- Codex/Claude 凭据读取、网络请求、状态栏、悬浮说明、刷新动画和定时刷新现在全部在当前工作区环境内运行。
