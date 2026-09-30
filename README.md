# Agent Center

Language: <a href="https://github.com/mapengsen/Agent-Center/tree/main">English (default)</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center brings AI coding-agent insights and utilities into VS Code. It displays Codex and Claude usage quotas in the status bar and helps open file links from Codex conversations.

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
- Automatic recovery for supported Codex file links through `code -r` (experimental, enabled by default).

![Agent Center status bar preview](image.png)

## Opening files from Codex

Update Agent Center, reload the VS Code window, and click an existing absolute file-path link in Codex. If Codex records the supported open failure, Agent Center runs `code -r` with that path. No special link format or changes to Codex are required. These 30 extensions are enabled by default:

| Category | Extensions |
| --- | --- |
| Images and PDF | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.ico`, `.pdf`, `.svg` |
| Markdown and documents | `.md`, `.markdown`, `.mdx`, `.rst` |
| Tabular data | `.csv`, `.tsv` |
| Web pages | `.html`, `.htm` |
| Notebooks | `.ipynb` |
| Research documents | `.tex`, `.bib` |
| Configuration and logs | `.log`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml` |
| Office documents | `.docx`, `.xlsx`, `.pptx` |

Files use the same default editor as a manual `code -r` command. PDF and Office preview require suitable viewer extensions; Markdown, CSV, and HTML are not forced into a rendered preview, table, or browser.

Supported files can also be opened successfully as plain text by Codex, so no failure log is produced. Agent Center detects these active text tabs, closes the unmodified text tabs for that file, and then runs `code -r`. Closing them first allows the CLI to select the default editor instead of reusing the text tab. Existing custom viewers, notebooks, diffs, and unsaved edits are preserved. The listener also checks the active text tab when it starts.

VS Code does not expose which extension opened a text tab. Consequently, this recovery applies to supported text tabs opened from any source, not just Codex. Turn off `agentStatus.codexImageLinks.reopenTextDocuments` to keep text tabs as they are, or remove individual formats from the extension list. If the default editor still returns a text tab, the listener leaves it available for editing and prevents a reopen loop, including when the CLI starts slowly.

Agent Center starts the CLI bundled with the current VS Code installation as a background process, passing the path as a literal argument. It does not type commands into your terminal. Remote sessions use the current extension host's CLI connection. On Windows, it runs the same CLI entry point as `code.cmd` directly, preserving spaces, Unicode, and special characters in paths. CLI failures appear in Show Diagnostics.

In Remote SSH, WSL, or Dev Containers, install Agent Center in the workspace environment where Codex handles the file. Both extensions must use the same extension host and window. This feature does not translate remote paths into local Windows paths. If you installed the separate experimental **Codex Image Opener** extension, disable or uninstall it first to avoid duplicate handling.

The failure-log fallback is based on the format inspected in Codex `26.917.62051`, not a public Codex click-event API; future Codex versions may require an adjustment. Text-tab recovery uses VS Code editor events independently of that log. Web URLs and virtual documents are not handled. Automated tests cover both recovery paths with a mocked VS Code API, CLI selection, and literal argument delivery to real child processes; actual clicks in a remote VS Code session have not yet been verified.

Agent Center reads only new entries from the current window's existing `Codex.log`, skips historical entries on activation, and opens files only in a focused, trusted window. It does not copy, move, or write that log. Recent recovery diagnostics are limited to 40 entries in memory; VS Code manages the original logs.

- `agentStatus.codexImageLinks.enabled`: turn automatic recovery on or off (default: `true`).
- `agentStatus.codexImageLinks.extensions`: replace the default list of extensions for both log and text-tab recovery. Entries are case-insensitive and accept an optional leading dot; duplicates are normalized. An empty list disables all formats.
- `agentStatus.codexImageLinks.reopenTextDocuments`: recover clean text tabs for the configured extensions from any source (default: `true`). Disable to keep the original text tabs.
- **Agent Center: Show Diagnostics**: inspect `codexImageLinks.status`, `extensions`, `textEditorRecovery`, the detected log path, and recent results. Results identify `codex-log` or `text-editor` as their source. `watching` means the log is available; `waiting for Codex.log` means it has not appeared at the expected location. Editor-event recovery can still run while waiting for the log.
- **Agent Center: Restart Codex File Link Listener**: restart after troubleshooting, then click the link again.
- `agentStatus.codexImageLinks.logFile`: advanced override for the absolute path to the current window and extension host's `Codex.log`. Leave empty for automatic detection. It selects a file to read, not a destination for new logs.

## Changelog

### 0.1.8 - 2026-09-30

- Removed `.txt` from the default `code -r` recovery formats. Other configured formats are unchanged.

### 0.1.7 - 2026-09-29

- Expanded `code -r` recovery to 31 formats, including Markdown, CSV/TSV, HTML, notebooks, LaTeX/BibTeX, text/configuration files (including TOML), and Office documents.
- Added a configurable extension list shared by both recovery paths, native notebook handling, and protection against repeated text-tab reopening after a slow CLI launch.

### 0.1.6 - 2026-09-29

- Fixed PDF/SVG recovery when Codex opens the file as text without logging an error: close the clean text tabs before running `code -r`.
- Added an independent text-tab recovery setting, unsaved-edit protection, loop prevention, and diagnostic event sources.

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
