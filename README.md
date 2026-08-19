# Agent Status

Language: <a href="./README.md">English (default)</a> | <a href="./README.zh-CN.md">简体中文</a>

Agent Status displays Codex and Claude usage quotas directly in the VS Code status bar.

**GitHub**: [github.com/mapengsen/Agent-Status](https://github.com/mapengsen/Agent-Status)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.agent-status)

## Features

- Compact status text such as `5% left | 8-20 11:24` or `5% used | 8-20 11:24`.
- Codex short- and long-window details, account email, and plan type.
- Claude 5-hour, 7-day, Opus, and Sonnet window details.
- Hover descriptions explaining the percentage, represented window, reset time, and last update. (Status-bar reset times use the time zone of the environment where Agent Status is running. If a remote server and Windows use different time zones, the displayed clock time may differ.)
- Remaining/used display modes, with click-to-refresh support directly from the status bar.
- An animated refresh indicator during startup, scheduled, and manual requests.
- An immediate startup refresh followed by a refresh every 30 seconds for a total of six times, then the regular default interval of 10 minutes.

![alt text](image.png)

## Changelog

### 0.1.0 - 2026-08-19

- Initial independent release extracted from Notifyer.
- Codex and Claude credential reads, network requests, status items, tooltips, refresh animation, and scheduling now run entirely in the current workspace environment.

## My Other Plugin Recommendations

**GitHub**: [github.com/mapengsen/Notifyer](https://github.com/mapengsen/Notifyer)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion)
