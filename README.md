# Agent Center

Language: <a href="https://github.com/mapengsen/Agent-Center/tree/main">English (default)</a> | <a href="https://github.com/mapengsen/Agent-Center/blob/main/README.zh-CN.md">简体中文</a>

Agent Center puts Codex and Claude usage quotas, Codex provider switching with shared history, VS Code internet connectivity, and Clash/Mihomo controls in the status bar. It also recovers file links from Codex conversations through `code -r`. It supports local workspaces, Remote SSH, WSL and Dev Containers.

**GitHub**: [github.com/mapengsen/Agent-Center](https://github.com/mapengsen/Agent-Center)

**Plugin**: [marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status)

## All features

| Feature | What you can do |
| --- | --- |
| Codex provider switching and shared history | Choose official ChatGPT login or directly select a configured API such as `beeapi`, with no repeated typing. Manual ID entry and first-use API setup remain available. Every switch makes all indexed local history available to the selected provider, with backups and failure recovery. |
| Codex usage quotas | See remaining or used percentages, short/long windows, reset times, account email and plan in the status bar and hover. |
| Claude usage quotas | Inspect 5-hour, 7-day, Opus and Sonnet windows when returned by the service, plus subscription and reset details. |
| Quota display and refresh | Choose remaining/used mode for each provider, see colored usage markers, click to refresh, and use automatic refresh with failure retries. |
| VS Code internet connectivity | Request only Google's public website from the extension host. Any HTTP response shows `✅️`; no response shows `❌`. The single icon sits before the Clash globe. Checks run at startup and every **5 hours**, with manual checks available. |
| Clash node and latency | See Google latency, the final active node, nested selection chain and routing mode. Read controller settings automatically from Clash/Mihomo, including custom Linux/WSL installations. Default test interval: **5 minutes**. |
| Switch Clash nodes | Click a node in the bottom-right hover card or search the full node list. Verify the selection and test latency after switching. |
| Test all Clash nodes in parallel | Manually test all concrete nodes loaded by the current Clash core, up to five at a time. Show sorted results in the existing hover, support cancellation and send no node-selection commands. |
| Test and select the best node | Run a fresh batch and select the successful node with the lowest Google latency reachable through the current group's manual selectors. Support nested selectors, verify the effective node and attempt recovery on failure. |
| Start and stop the proxy | Use native Clash controls in the same hover, verify the controller starts or stops, retain subscriptions and keep the start action available while stopped. |
| Update the current subscription | Download, force-load and verify the active source, preserving available manual choices. After success, immediately refresh Google connectivity, current-node state and all loaded node delays without selecting a new node. Restore on update failure; updates while stopped keep the service stopped. |
| Use subscription DNS | Remove conflicting local DNS resolution overrides, keep host DNS enable/listen/IPv6 settings, update the active source and verify the generated DNS policy. Preserve backups, support restoring original DNS overrides and check a complete Google webpage through the current local proxy. Linux/WSL only. |
| Add, switch and delete subscriptions | Paste a URL to detect its name, save without switching or apply immediately, view the active subscription, and delete any subscription. Deleting the active source switches to the next enabled one; without a replacement, Clash stops. Requires compatible clash-for-linux. |
| Recover Codex file links | Open supported absolute file links with `code -r`, including images, PDF, SVG, Markdown, CSV, TOML and Office files: **30 default formats**, with a configurable list. Recover failed opens and clean text tabs; preserve unsaved edits and prevent reopen loops. |
| Remote use, settings and diagnostics | Run in the current local or remote extension host, configure feature switches, credentials and proxies, and inspect quota, connectivity, Clash and file-link diagnostics. |

## Getting started

1. Install **Agent Center** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-claude-agent-status) and reload the window. For Remote SSH, WSL or a container, install it in that workspace environment.
2. For quotas, sign in with `codex login` or `claude /login` in the same environment. Agent Center reads that environment's existing CLI credentials. A provider's quota item stays hidden when its credentials are unavailable or unusable.
3. Google connectivity works without Clash or an API key. For node status and switching, run Clash/Mihomo with an accessible controller; subscription management additionally needs compatible clash-for-linux.
4. Hover over a quota item for details; click it to refresh. Hover over or click the Google/Clash item to open the native card above the bottom-right status bar, with network, node and subscription actions.
5. Click the **OpenAI 官方 / provider ID** status item or run **Agent Center: Switch Codex Provider**. This feature requires **Python 3.8+ with sqlite3** in the extension host. Reload the VS Code window after switching.

| Automatic task | Default schedule | Manual action |
| --- | --- | --- |
| Codex quota | At startup, three more checks 60 seconds apart, then every **3 minutes**; failed regular checks retry every 30 seconds, up to five attempts per cycle. | Click the quota item or use its refresh command. |
| Claude quota | At startup, three more checks 60 seconds apart, then every **15 minutes**; failed regular checks retry every 30 seconds, up to five attempts per cycle. | Click the quota item or use its refresh command. |
| VS Code host → Google | At startup, then every **5 hours**, and immediately after a successful subscription update. | Choose “立即检测联网” in the hover card. |
| Clash node → Google | At startup, then every **5 minutes**; also after node or subscription switches. Successful subscription updates additionally test all loaded nodes in parallel. | Choose “刷新测速” in the hover card. |

![Agent Center status bar preview](image.png)

The image shows the quota items. A combined connectivity and Clash example is `✅️ 🌐 √ Google（1605 ms）`: the leading icon is the extension-host check, and the latency is the independent Clash node test.

## Codex provider switching and shared history

Click the dedicated provider status item, use the Codex quota hover action, or run **Agent Center: Switch Codex Provider**. The dedicated item is available even without quota credentials.

- **OpenAI 官方（ChatGPT 登录）** selects built-in `openai` and ChatGPT authentication, retaining existing login files. Complete ChatGPT login in Codex if needed. User-level custom OpenAI/ChatGPT endpoint overrides are removed; a custom `OPENAI_BASE_URL` environment override must be cleared first.
- **Configured APIs**, such as **beeapi**, are listed directly from `[model_providers.*]` in the current environment's `config.toml`. Click the desired ID to reuse its address and credentials, without any text input. The menu shows each configured display name and marks the current provider; reopening it picks up external config edits. Only IDs and names appear in the list.
- **输入其他 API ID…** is the optional manual-entry fallback. For `model_provider = "beeapi"`, enter `beeapi`, not a model or display name. An existing configuration is reused. For a new ID, enter a Responses-compatible Base URL and a masked API Key; these are saved in `config.toml`, never in VS Code settings or diagnostics. Custom providers requiring ChatGPT authentication must be configured for API authentication first.

Each explicit switch updates the provider label of **all indexed local threads in the current `CODEX_HOME`** so the same history is available whichever provider you select. Conversation bodies, JSONL files, pagination offsets, titles, order, archives and login files are preserved. Archived chats remain in their archived list; workspace and thread-type filters still apply. Continuing a chat after reload uses the selected provider, subject to its model and feature support. The scope is this environment's local history. The quota item still reports the saved ChatGPT account's quota, independently of custom API balances.

Backups are saved to `CODEX_HOME/agent-center/provider-backups/` (default `~/.codex/agent-center/provider-backups/`). The last **five successful switch backups** are retained; failed-switch backups are kept for recovery. SQLite backups include WAL data; cross-window locks, configuration-change checks and rollback protect existing records. Only history index labels change; transcripts are never rewritten. Stop active Codex replies before switching, then choose **重新加载窗口** after success.

Install Python 3.8+ with `sqlite3` on the extension host, or set `agentStatus.codexProvider.pythonPath`. Automatic discovery tries `python3`, `python` and Windows `py -3`. POSIX config and backups use private permissions; Windows uses the Codex directory's ACLs. Incompatible indexes, legacy transcripts without an index, active config profiles and malformed TOML produce an error before switching. Managed settings or custom Codex launch flags can still override provider selection.

## Codex and Claude usage quotas

Status items use compact text such as `5% left | 10-17 11:24` or `5% used | 10-17 11:24`. Each provider has its own remaining/used display setting. Hover details explain the selected window and percentage, account or session, plan, reset time, last update and available actions. Colored emoji markers progress from green through yellow and orange to red as the used percentage increases. Quotas are window percentages, rather than absolute token or request counts.

Codex displays the short window when available, falling back to the long window. Claude prefers its 5-hour window and shows other returned 7-day, Opus and Sonnet windows in the hover. Reset timestamps use the extension host's time zone, which can differ between a remote server and your local computer. Manual quota refreshes show an animation; background refreshes retain the current display.

Credentials are read from `CODEX_HOME/auth.json` or `~/.codex/auth.json` for Codex, and `CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` for Claude. Override them with `agentStatus.codex.credentialsPath` or `agentStatus.claude.credentialsPath`. Each provider also has `enabled`, `usageDisplayMode`, `usageUpdateIntervalSeconds` and an optional HTTP/HTTPS `proxyUrl` setting. Quota requests use the existing logged-in session and the provider's quota endpoint; the Google connectivity probe is separate and needs no login.

## Google website connectivity

The current VS Code extension host requests `https://www.google.com/`. A single connectivity icon appears before the globe in the existing Clash status item, for example `✅️ 🌐 √ Google（1605 ms）`:

- `✅️`: any HTTP response, including 200, redirects, 403, 429 and 5xx.
- `❌`: no HTTP response, including timeouts, DNS, connection or certificate failures.

Checks run at startup and every five hours by default. Hover or click the same item to inspect HTTP status, timing, execution environment and timestamp, or choose “立即检测联网”. The command is **Agent Center: Test Google Website Connectivity**. There is no separate ChatGPT status item; without Clash only the connectivity icon is displayed. Refreshes retain the previous icon; no icon is shown before the first result.

This connectivity check only contacts the Google public website, without ChatGPT, Claude, quota or chat API requests, credentials or API keys. It stops at response headers without downloading the page or following redirects. `✅️` means an HTTP response arrived; it does not establish that page features work. This is independent of Clash's core-based node test, so the two results may differ. Existing Codex/Claude quota features retain their own requests and settings.

Requests use Node HTTP(S) with VS Code's extension-host proxy and certificate support, following the effective `http.proxy`, `http.proxySupport` and environment proxy handling. Remote SSH, WSL and container windows test the remote extension host; ordinary windows test the local host. Environment variables set later in a terminal may not reach an already-running extension host. This reports Agent Center's public-page access; other extensions depend on their own requests.

Settings: `agentStatus.network.enabled`, `testTimeoutMs` (15000 ms by default), and `updateIntervalSeconds` (18000 seconds, or five hours, by default). The Clash node test keeps its independent five-minute default. Checks require workspace trust; disabling or disposing cancels pending requests. **Agent Center: Show Diagnostics** includes the latest result under `network` without proxy passwords.

## Clash nodes and Google latency

Install Agent Center in your Remote SSH environment and reload the window. On Linux/WSL it first discovers the running Clash/Mihomo core's `-f` config or `-d` data directory, supporting custom installation paths. It also checks environment hints, Clash command launchers on PATH and literal clashctl paths in shell integration files before falling back to ~/clash-for-linux/runtime/config.yaml, ~/.config/mihomo/config.yaml and common system locations. The controller address and secret are read automatically.

- The status bar shows **√ Google（3349 ms）**, or **× 超时** when the delay test fails.
- Hover to see the final node, nested selection chain and routing mode. Rule mode displays the selected proxy group; other rules may use different groups.
- Click the status bar to immediately open the same hover card above the bottom-right status item, with current-node, latency and subscription information. Click a node to switch, or “全部节点” for the searchable full list. The selection is verified and latency refreshed afterward.
- Tests use the same Google endpoint as clashtest, https://www.gstatic.com/generate_204, with an 8-second default timeout. This measures latency in milliseconds, rather than download bandwidth.
- Refreshes and tests latency automatically every 5 minutes (300 seconds) by default. Manual refreshes and node or subscription switches test immediately. Without a discovered Clash service, only the independent connectivity icon is shown when enabled; controller failures provide retry actions.

### Test all nodes in parallel

Click **全部节点测速** in the existing bottom-right hover, or run **Agent Center: Test All Clash Nodes**. Each node uses the same Google endpoint and timeout as the current-node test, through its own delay API request. Up to **five** requests run concurrently, with remaining nodes queued. This includes proxy-provider nodes loaded by the current core, excluding policy groups and built-in Direct/Reject types. It does not download or rotate other saved subscriptions or send node-selection commands; automatic groups keep following the core's own policy.

The same hover updates each result as **√ Google（3349 ms）** or **× 超时**, sorts successful nodes by latency and puts failures last. The full node picker also displays results from this batch. Cancel from the progress notification, **取消测速** in the hover, or **Agent Center: Cancel Clash Node Tests** to abort waiting requests and stop the queue, retaining completed results. Results are timestamped and kept in memory; configuration updates, subscription switches and changes to the node list clear them. The five-minute automatic task still tests only the current selection. These are latency tests, not download bandwidth or a guarantee that every website works.

Usually leave configPath, installDirectory, controller and secret empty. For multiple instances, restricted process access or a controller in another environment, set **agentStatus.clash.configPath** in Remote Settings. Explicit configuration takes priority; specifying only installDirectory checks its `runtime/hosts/<current-hostname>/config.yaml` before `runtime/config.yaml`. Leave group empty to choose a manual group in configuration order; global mode uses GLOBAL and direct mode uses DIRECT. Set group explicitly when you want a particular rule-mode group. testTimeoutMs, updateIntervalSeconds and enabled control timeout, refresh interval and visibility.

Discovery only reads the extension host's process arguments and command registrations: it does not execute shell startup scripts, scan the entire disk, change services or persist deployment paths. Refreshes rediscover moved or restarted cores, and subscription management infers its installation from the discovered runtime config. When several cores are running, the first readable config in PID order wins; explicit settings select a particular instance.

All requests run in the extension host, so 127.0.0.1 in Remote SSH refers to the remote server. Wildcard controller bind addresses are normalized to loopback. Node selections use the controller API, whose persistence behavior is managed by Clash/Mihomo. Diagnostics include nodes and errors without the controller secret.

Commands: **Agent Center: Refresh Clash Node Speed**, **Agent Center: Choose Clash Node**, and **Agent Center: Show Diagnostics** (the clash field).

### Test and select the best node

Click **测速并切换最佳节点** in the existing hover, or run **Agent Center: Test and Select Best Clash Node**. Every invocation runs a fresh batch with up to five concurrent tests, then picks the successful node with the lowest Google latency **reachable through manual Selector groups from the current group**. Equal delays prefer the current final node. “Best” refers to this batch's Google latency, rather than bandwidth or availability of every website.

Nested manual selectors are changed from the inside out, then the effective final node is verified. An already-selected best manual path needs no writes. Failed candidates or cancellation during testing leave selections unchanged. Before switching, the mode, relevant groups and manual choices are checked for changes. A failed switch attempts to restore this operation's writes without overwriting detected later choices from another client, and reports recovery status. Results and selection details stay in the same hover; the status bar reflects the verified node and delay.

This action does not change routing mode, subscriptions, rules, DNS or configuration files. Direct mode and an automatic-only current group require a manual selector first; automatic groups are not forcibly pinned. The existing **全部节点测速** action remains test-only, and the five-minute automatic task still tests the current node without selecting a new one.

### Start, stop and update the current subscription

The existing status-bar hover includes **开启代理**, **关闭代理** and **更新当前订阅**, also available as the commands below. These call [wnlen/clash-for-linux](https://github.com/wnlen/clash-for-linux)'s native `clash on`, `clash off` and `clash sub update`. Updating reuses the saved source URL; “Refresh Clash Node Speed” still only tests latency.

Running updates force-load the generated configuration and verify its live nodes and groups. Manual choices that still exist are preserved. Failures attempt to restore the original configuration, subscriptions, choices and service state; updates started while stopped keep the service stopped. Native per-host runtimes and legacy `scripts/cmd/clashctl.sh` installations are supported for these three actions.

After a successful update, old delay results are discarded, current node/subscription state is reloaded and all newly loaded concrete nodes are tested with up to five requests in parallel. The extension-host Google check restarts alongside this workflow, cancelling any request begun before the update rather than reusing it. New results update the existing hover and timestamps immediately, without waiting for the five-minute or five-hour schedules. This is test-only; it does not select the best node.

Updates while stopped still refresh host connectivity but do not start the proxy for delay testing. A failed subscription update does not launch this full refresh. Post-update connectivity or latency errors are reported separately and do not undo a successful subscription update. Existing feature switches and periodic schedules remain in effect.

Controls operate in the current Linux/WSL extension host. Native scripts manage the service and persistent proxy state; child processes cannot rewrite environment variables of already-running terminals or VS Code. Reopen a terminal or reconnect the remote window when needed. The Google connectivity badge keeps its independent check schedule.

### Add, switch and delete subscription sources

Click “添加订阅” / “切换订阅” / “删除订阅” in the status-bar hover, or run **Agent Center: Add Clash Subscription** / **Agent Center: Choose Clash Subscription** / **Agent Center: Remove Clash Subscription**.

- The picker shows provider names from `profile-title` or download filenames, falling back to source hostnames. Details retain native identifiers and source hosts to distinguish duplicate names. Opening a subscription picker or adding a URL requests metadata; reading stops after headers without applying a configuration. Names are cached in memory for one hour (five minutes on failure), and routine latency refreshes reuse the cache.
- Paste an HTTP/HTTPS Clash YAML subscription URL; the name is detected automatically, falling back to its hostname. Names are made safe for native storage and duplicates receive a suffix such as `-2`. Choose to save for later or switch immediately. Saving alone does not download or replace the active configuration.
- Switching uses the remote installation's native `use` command to download, compile and restart Clash, briefly interrupting proxy connections. Failed switches attempt to restore the previous subscription and manual node selections, and report whether recovery succeeded.
- Every subscription, including `default`, can be removed after confirmation. Removing the active source first applies and verifies the next enabled source in list order (wrapping to the start); if switching fails, the old source is retained. Removing an inactive source preserves the current connection. With no enabled replacement, Clash is stopped before removing the source; removing the last one clears the list. Adding and switching a new source can start it again. Agent Center uses the installation's native configuration writer and `yq` for storage, adapting the native script's `default` restriction without editing its source.
- The URL input is masked. URLs persist in the native runtime's `subscriptions.yaml`; Agent Center does not include them in source code, VS Code settings or logs. It passes URLs to the native subscription writer through standard input; clash-for-linux manages subsequent downloads. Protect the server's subscription file.
- Requires compatible clash-for-linux scripts and subscription storage on a Linux/WSL extension host. Discovery derives the installation from both `runtime/config.yaml` and per-host `runtime/hosts/<hostname>/config.yaml`, keeping subscription reads, locks and recovery in that runtime. Native commands must use the same directory; another host's runtime is rejected. Set `agentStatus.clash.installDirectory` if automatic discovery is unavailable. A standalone Clash controller API does not provide this subscription management.

The hover also shows the active subscription's cached name (or source hostname) and native identifier.

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

## DNS from the subscription (Linux/WSL)

Choose **DNS 使用订阅配置** in the existing bottom-right Clash hover, or run **Agent Center: Use Subscription DNS**. This is opt-in and applies to the detected clash-for-linux installation. It supports current runtime mixins, host-specific runtime directories and the legacy `resources/mixin.yaml` layout.

The action backs up the active configuration, subscription state and Mixin under the current runtime's `.agent-center-backups/<timestamp>-dns-<id>/`, then removes local DNS resolution overrides such as nameservers, split-DNS policy, fallback and fake-IP settings. Host DNS `enable`, `listen` and `ipv6` remain local; proxy ports, controller credentials, TUN, nodes and rules are retained. Shared fallback mixins are copied into the host runtime rather than edited globally. The current source is updated and its DNS policy is compared with the generated configuration before a running core is force-reloaded. A subscription without a meaningful DNS policy or an unsupported source layout fails with recovery rather than silently clearing local DNS.

The Mixin change persists through native subscription updates and switches. While the policy marker is active, Agent Center start/update actions also remove accidentally reintroduced DNS overrides and verify the result. Reinstallation, manually restoring files or changing the build pipeline may require applying the action again. **恢复原 DNS 覆写** / **Agent Center: Restore Clash DNS Overrides** restores the original DNS resolution overrides while retaining later edits to unrelated settings and host DNS infrastructure. Download, build, verification or reload failures attempt to restore the original files, node selections and on/off state; a stopped proxy stays stopped. Backups contain configuration secrets and use private directory/file permissions.

After a running core reloads, Agent Center attempts to flush its DNS cache where supported and uses `curl` through the local HTTP or SOCKS proxy to download Google's public webpage (15-second limit, successful HTTP status and nonempty body required). A failed webpage check is reported separately: the verified DNS policy remains applied, and other node/routing problems may still need diagnosis. This result does not redefine the existing green latency or Google host-connectivity icon. With no curl, no local proxy port, proxy authentication or a stopped proxy, the check is explicitly marked skipped. No ChatGPT login or API key is used. DNS backups and the latest webpage result appear in diagnostics.

## Commands

Open the command palette with `Ctrl+Shift+P` / `Cmd+Shift+P` and search for **Agent Center**. Every contributed command is listed here:

| Command | Purpose |
| --- | --- |
| Agent Center: Switch Codex Provider | Choose official ChatGPT or enter an API ID; share all indexed local history with the selected provider. |
| Agent Center: Refresh Codex Usage | Refresh the current environment's Codex quota. |
| Agent Center: Choose Codex Usage Display | Choose remaining or used percentage for Codex. |
| Agent Center: Refresh Claude Usage | Refresh the current environment's Claude quota. |
| Agent Center: Choose Claude Usage Display | Choose remaining or used percentage for Claude. |
| Agent Center: Test Google Website Connectivity | Run the extension-host Google check immediately. |
| Agent Center: Refresh Clash Node Speed | Read Clash state and test the selected node's Google latency. |
| Agent Center: Test All Clash Nodes | Manually test all loaded concrete nodes in parallel and show results in the existing hover. |
| Agent Center: Test and Select Best Clash Node | Run fresh tests, select the lowest-latency successful node reachable through the current manual group, and verify or recover. |
| Agent Center: Cancel Clash Node Tests | Cancel the current all-node batch, retaining completed results. |
| Agent Center: Start Clash Proxy | Start the current environment's native proxy and verify its loaded configuration. |
| Agent Center: Stop Clash Proxy | Stop the proxy, verify the controller stops and retain subscriptions. |
| Agent Center: Update Current Clash Subscription | Refresh the active source while preserving its on/off state; immediately refresh host/current/all-node tests after success and recover on update failure. |
| Agent Center: Use Subscription DNS | Persist subscription DNS priority, update/verify the active source and report a webpage check through Clash. |
| Agent Center: Restore Clash DNS Overrides | Restore backed-up DNS overrides while retaining later unrelated edits and the proxy's on/off state. |
| Agent Center: Choose Clash Node | Search for and switch a node in a manual selector group. |
| Agent Center: Add Clash Subscription | Paste a URL, detect its name, then save or switch. |
| Agent Center: Choose Clash Subscription | Select and apply a saved subscription. |
| Agent Center: Remove Clash Subscription | Confirm deletion, switching or stopping Clash when needed. |
| Agent Center: Restart Codex File Link Listener | Restart log detection and text-tab recovery. |
| Agent Center: Show Diagnostics | Inspect all monitors in the Agent Center output channel. |
| Agent Center: Open Settings | Open this extension's settings. |

## Feature settings and diagnostics

Search for **Agent Center** in Settings, or run **Agent Center: Open Settings**. These switches are independent and enabled by default:

| Settings group | Enable/disable | Other options |
| --- | --- | --- |
| Codex provider switching | `agentStatus.codexProvider.enabled` | `pythonPath` |
| Codex quota | `agentStatus.codex.enabled` | `credentialsPath`, `usageDisplayMode`, `usageUpdateIntervalSeconds`, `proxyUrl` |
| Claude quota | `agentStatus.claude.enabled` | `credentialsPath`, `usageDisplayMode`, `usageUpdateIntervalSeconds`, `proxyUrl` |
| Extension-host Google check | `agentStatus.network.enabled` | `testTimeoutMs`, `updateIntervalSeconds` |
| Clash nodes and subscriptions | `agentStatus.clash.enabled` | `configPath`, `controller`, `secret`, `installDirectory`, `group`, `testTimeoutMs`, `updateIntervalSeconds` |
| Codex file-link recovery | `agentStatus.codexImageLinks.enabled` | `extensions`, `reopenTextDocuments`, `logFile` |

Each option in the last column uses its row's prefix, for example `agentStatus.network.updateIntervalSeconds`. With Remote SSH, WSL or containers, use the current remote environment's settings and paths. Existing legacy Notifyer quota settings are used as fallbacks when the corresponding Agent Center setting is not explicitly configured.

**Agent Center: Show Diagnostics** opens the output channel with `codex`, `codexProvider`, `claude`, `network`, `clash` and `codexImageLinks` results. Inspect the active provider, history count, backup location and existing monitor results. Output omits access tokens, API keys, proxy passwords, controller secrets and complete private subscription URLs. Provider switching, file-opening, network and Clash operations require a trusted workspace.

## Related extension

[Notifyer](https://marketplace.visualstudio.com/items?itemName=pengsen.codex-task-companion) is another extension by the same publisher.

## Changelog

See [the complete changelog](CHANGELOG.md) for every release.

### 0.1.31 - 2026-10-22

- Immediately refresh host Google connectivity, current state and all loaded node delays after a successful subscription update. Restart stale host requests without selecting a new node; retain periodic schedules, the stopped state and update recovery.

### 0.1.30 - 2026-10-22

- Add “Test and Select Best Clash Node”: run a fresh batch, select the fastest successful node reachable through the current group's manual selector chain, verify the result and recover on failures. Test-only and automatic actions retain their behavior.

### 0.1.29 - 2026-10-22

- Add cancellable parallel testing of all loaded proxy nodes, up to five at a time, with per-node Google delays and failures in the existing hover and no node-selection writes.

### 0.1.28 - 2026-10-22

- Add opt-in subscription DNS priority and DNS-only restore to the native Clash hover, with private backups, generated-policy verification, failure recovery and an independent full-webpage proxy test.

### 0.1.27 - 2026-10-21

- Refresh Codex quotas every three minutes by default (180 seconds), preserving startup checks, retries and manual refresh. Claude remains at fifteen minutes.

### 0.1.26 - 2026-10-21

- Select configured Codex APIs directly from the provider menu, showing their IDs, names and current selection without repeatedly entering an ID or API credentials.

### 0.1.25 - 2026-10-21

- Add Codex provider switching, first-use API setup, shared local history, backups and recovery. Update the complete feature overview on GitHub and the Marketplace.

### 0.1.24 - 2026-10-21

- Start/stop Clash and update the current subscription from the native hover, with verified live reload and failure recovery.

### 0.1.23 - 2026-10-19

- Support custom per-host clash-for-linux runtime directories.

### 0.1.22 - 2026-10-17

- Document the full feature set, setup, refresh schedules, settings and all commands on both the GitHub and Marketplace homepages.

### 0.1.21 - 2026-10-17

- Set extension-host Google checks to run every five hours, keeping Clash node tests at five minutes by default.

### 0.1.20 - 2026-10-17

- Detect Google connectivity with a single `✅️` / `❌` before the Clash globe, treating any HTTP response as connected.

### 0.1.10 - 2026-10-15

- Added clash-for-linux subscription saving, switching, active-subscription hover details and recovery after failed switches.

### 0.1.9 - 2026-10-15

- Added Clash/Mihomo Google latency, current-node hover details and one-click switching, with automatic remote configuration discovery.

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
