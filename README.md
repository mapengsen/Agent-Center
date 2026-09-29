# Agent Center

Language: <a href="https://github.com/mapengsen/Agent-Center/tree/main">English (default)</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center brings AI coding-agent insights and utilities into VS Code. It displays Codex and Claude usage quotas in the status bar and helps open image links from Codex conversations.

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
- Automatic recovery for supported Codex image links that fail to open (experimental, enabled by default).

![Agent Center status bar preview](image.png)

## Opening images from Codex

Update Agent Center, reload the VS Code window, and click an existing absolute file-path link in Codex. If Codex records the supported open failure, Agent Center runs `code -r` with that path. No special link format or changes to Codex are required. Supported formats: PNG, JPEG, GIF, WebP, BMP, ICO, PDF, and SVG. PDF preview requires a suitable viewer extension; SVG and other files use your configured default editor.

Agent Center starts the CLI bundled with the current VS Code installation as a background process, passing the path as a literal argument. It does not type commands into your terminal. Remote sessions use the current extension host's CLI connection. On Windows, it runs the same CLI entry point as `code.cmd` directly, preserving spaces, Unicode, and special characters in paths. CLI failures appear in Show Diagnostics.

In Remote SSH, WSL, or Dev Containers, install Agent Center in the workspace environment where Codex handles the file. Both extensions must use the same extension host and window. This feature does not translate remote paths into local Windows paths. If you installed the separate experimental **Codex Image Opener** extension, disable or uninstall it first to avoid duplicate handling.

This is a compatibility workaround based on the failure-log format inspected in Codex `26.917.62051`, not a public Codex click-event API. Relative paths and web URLs are not handled. A future Codex update may require an adjustment. Automated tests cover log recovery with a mocked VS Code API, CLI selection, and literal argument delivery to real child processes; actual clicks in a remote VS Code session have not yet been verified.

Agent Center reads only new entries from the current window's existing `Codex.log`, skips historical entries on activation, and opens files only in a focused, trusted window. It does not copy, move, or write that log. Recent recovery diagnostics are limited to 40 entries in memory; VS Code manages the original logs.

- `agentStatus.codexImageLinks.enabled`: turn automatic recovery on or off (default: `true`).
- **Agent Center: Show Diagnostics**: inspect `codexImageLinks.status`, the detected log path, and recent results. `watching` means the log is available; `waiting for Codex.log` means it has not appeared at the expected location.
- **Agent Center: Restart Codex Image Link Listener**: restart after troubleshooting, then click the link again.
- `agentStatus.codexImageLinks.logFile`: advanced override for the absolute path to the current window and extension host's `Codex.log`. Leave empty for automatic detection. It selects a file to read, not a destination for new logs.

## Changelog

### 0.1.5 - 2026-09-29

- Changed recovery to execute `code -r` through the bundled CLI, with remote-window connection handling and bounded process execution.
- Added PDF and SVG links, plus diagnostics for CLI failures.

### 0.1.4 - 2026-09-29

- Added automatic recovery for supported absolute image links in Codex, with diagnostics and an enable/disable setting.
- Added incremental, bounded log reading with rotation handling and duplicate suppression; recovery diagnostics stay in memory.

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
