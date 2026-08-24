# Agent Center

Language: <a href="https://github.com/mapengsen/Agent-Center/tree/main">English (default)</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center brings AI coding-agent insights and utilities into VS Code. The current release displays Codex and Claude usage quotas directly in the status bar.

**GitHub**: [github.com/mapengsen/Agent-Center](https://github.com/mapengsen/Agent-Center)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status)

**All My Plugin Recommendations:**

1. **Notifyer Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion)
2. **Agent Center**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status)

## Features

- Compact status text such as `5% left | 8-20 11:24` or `5% used | 8-20 11:24`.
- Codex short- and long-window details, account email, and plan type.
- Claude 5-hour, 7-day, Opus, and Sonnet window details.
- Structured hover details with colorful, category-specific emoji for status meaning, account, plan, usage windows, reset time, last update, and actions. Percentage markers change from green through yellow and orange to red as usage rises. (Status-bar reset times use the time zone of the environment where Agent Center is running. If a remote server and Windows use different time zones, the displayed clock time may differ.)
- Remaining/used display modes, with click-to-refresh support directly from the status bar.
- An animated refresh indicator during manual requests only; automatic refreshes keep the normal status display.
- An immediate startup refresh followed by three automatic refreshes at 60-second intervals, then the regular default interval of 15 minutes. Failed regular refreshes retry every 30 seconds, up to five attempts per cycle.

![Agent Center status bar preview](image.png)

## Changelog

### 0.1.3 - 2026-08-24

- Replaced monochrome hover Codicons with a distinct set of colorful emoji markers.
- Added green, yellow, orange, and red percentage indicators based on used quota.

### 0.1.2 - 2026-08-24

- Renamed the visible extension brand to Agent Center while retaining the existing Marketplace extension ID.
- Added Codicon section markers to Codex and Claude hover details.
- Moved the source repository to `mapengsen/Agent-Center`.

### 0.1.1 - 2026-08-20

- Refined startup, regular refresh, and retry scheduling.
- Limited the spinning refresh indicator to manual refreshes.

### 0.1.0 - 2026-08-19

- Initial independent release extracted from Notifyer.
- Codex and Claude credential reads, network requests, status items, tooltips, refresh animation, and scheduling now run entirely in the current workspace environment.
