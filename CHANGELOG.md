# Changelog / 更新日志

## 0.1.46 - 2026-10-28

### Added / 新增

- Add a persistent reload-server-list link beside GPU server selections. Reread 可用服务器.md and recheck connections even when file contents are unchanged or a shared-storage edit was not detected automatically.
- 在 GPU 服务器选择行增加常驻的“重读服务器列表”入口。点击重新读取可用服务器.md 并检查连接，即使文件内容未变化或共享存储修改未触发自动通知，也可更新连接标记。

## 0.1.45 - 2026-10-27

### Fixed / 修复

- Allow 30 seconds for local nvidia-smi and 32 seconds for SSH sampling so slower multi-GPU hosts can return the full table. Preserve cancellation and non-overlapping reads; remove the loading hint after an empty failed sample.
- 当前机器的 nvidia-smi 等待上限改为 30 秒，SSH 采样改为 32 秒，兼容完整表格读取较慢的多 GPU 主机。保留取消和防并发机制，修复失败且无输出时仍显示正在读取的提示。

## 0.1.44 - 2026-10-26

### Changed / 调整

- Show the GPU server failure marker (不能连接) in red while keeping the complete server button clickable for retry. Clear the marker after recovery.
- GPU 服务器的 (不能连接) 标记改为红色，保留整个服务器按钮的点击重试功能；恢复连接后清除标记。

## 0.1.43 - 2026-10-26

### Changed / 调整

- Enlarge aggregate CPU usage while keeping its percentage blue; compact the equivalent-core and whole-machine usage line. Remove the footer hint about hiding the card and background sampling.
- 放大 CPU 总占用并保留蓝色百分比，缩小折合核心数与全机占用一行；删除移开隐藏及后台监控的底部提示。

## 0.1.42 - 2026-10-26

### Added / 新增

- Check SSH login for discovered servers with two concurrent probes and mark failed entries with (不能连接) directly in their selector labels. Retry on selection or list reload, clear recovered labels and prevent stale probes from overriding newer successful samples.
- 自动检查服务器 SSH 登录，最多 2 台并行，失败名称直接标注 (不能连接)；点击服务器或重读列表可重试，恢复后清除标注，旧探测不会覆盖更新的成功采样。
- Keep login probes separate from active sampling and treat missing GPU tools as command failures rather than failed connections.
- 登录探测与当前采样连接分开，GPU 工具缺失单独显示命令错误，不误标为连接失败。

## 0.1.41 - 2026-10-26

### Added / 新增

- Discover SSH server entries in the active workspace root's 可用服务器.md. Add current-host/server selection links above the existing GPU/CPU hover, switch both readings together and sample the selected host every two seconds over a reused SSH connection.
- 自动读取当前工作区根目录的可用服务器.md，在原有 GPU/CPU 浮窗上方增加当前机器及各服务器入口，点击后同时切换 CPU/GPU，每 2 秒通过复用 SSH 连接采样所选机器。
- Support password, identity-file and agent/default-key authentication, Linux CPU counters and raw nvidia-smi tables. Watch list edits/deletions and workspace-root changes, return to the current host if the selected entry disappears, and expose manual list reload.
- 支持密码、密钥文件及 Agent/默认密钥登录，读取 Linux CPU 计数和 nvidia-smi 原始表格。自动处理列表修改、删除和工作区根目录变化，当前条目删除后回到当前机器，提供手动重读命令。
- Validate entries as connection data instead of executing document commands. Keep credentials out of links/diagnostics, pin SSH host keys, cap connection/read times and output sizes, cancel old reads on switching and suppress stale frames.
- 只把条目作为连接数据解析，不执行文档中的命令；凭据不进入链接或诊断，记录并校验主机密钥，限制连接/采样时间及输出，切换时取消旧读取并抑制过期数据。

## 0.1.40 - 2026-10-26

### Changed / 调整

- Show the aggregate CPU percentage in blue and remove the host-information line from the GPU/CPU hover. Retain the wider table layout, CPU details, actions and two-second monitoring.
- CPU 总占用百分比改为蓝色，删除 GPU/CPU 浮窗中的主机信息行；保留加宽表格、CPU 详情、操作入口和 2 秒监控。

## 0.1.39 - 2026-10-26

### Changed / 调整

- Remove the GPU/CPU hover title, CPU percentage explanation, refresh/hover hint and extra update timestamp. Retain host details, CPU readings, actions, the original nvidia-smi table and two-second monitoring.
- 删除 GPU/CPU 浮窗标题、CPU 百分比说明、刷新/悬停提示及额外的更新时间；保留主机、CPU 数据、操作入口、原始 nvidia-smi 表格和 2 秒监控。

## 0.1.38 - 2026-10-26

### Fixed / 修复

- Use a native text code block for the CPU reading to activate VS Code's wider code-hover layout, while retaining the preformatted GPU table and its original hover font. Keep CPU details, hover behavior and two-second polling; respect native window/font size limits.
- CPU 读数使用原生纯文字代码块，让 VS Code 使用更宽的代码浮窗布局；GPU 表格保留原来的预格式化文字与字体，改善列截断且避免换行破坏对齐。保留 CPU 详情、悬停交互和 2 秒监控，遵循原生窗口与字体尺寸限制。
- Continue escaping all sampled HTML and trusting only the monitor/settings commands, keeping process names literal and preventing command-link injection.
- 继续转义全部采样 HTML，仅信任监控与设置命令，进程名仅按文字展示，避免内容变成命令链接。

## 0.1.37 - 2026-10-26

### Changed / 调整

- Replace the independent editor panel with a native GPU/CPU floating status-bar hover. Hover to show, move away to hide, with no editor tab or layout changes. Native hover updates may flicker or reset scrolling.
- GPU/CPU 改为状态栏原生浮动卡片，悬停显示、移开隐藏，不打开编辑器或改变布局；原生卡片更新可能闪烁或重置滚动位置。
- Keep aggregate CPU usage, equivalent busy logical processors, whole-machine percentage, complete nvidia-smi output, pause/resume and single refresh. Sample automatically at startup and two seconds after each completed read; native-hover visibility does not stop background monitoring. Preserve cancellation, timeout, trust and output-escaping protections.
- 保留 CPU 总占用、折合满载逻辑核心数、整机百分比、完整 nvidia-smi 表格、暂停、继续及单次刷新。启动后自动监控，每轮结束 2 秒后再采样；移开只隐藏卡片，后台继续监控，保留取消、超时、信任与输出转义保护。

## 0.1.36 - 2026-10-26

### Added / 新增

- Move GPU monitoring into a large independent editor area, separate from Codex. Close only this panel after pointer exit, with a pin button for resizing and Escape to close. Pause on hide/close and retain the last frame and auto-hide scroll position.
- GPU 改为独立于 Codex 的大编辑区域；鼠标进入后移出自动关闭，只关闭自己的标签。支持固定后调整大小、Escape 关闭，隐藏/关闭自动暂停，保留上次数据与自动关闭时的滚动位置。
- Show interval-based CPU usage above the GPU table: 100% per logical processor, equivalent busy processors, logical CPU count and whole-machine percentage. Sample on the current extension host, handle cancellation and invalid counters, and update text in place without rebuilding the page.
- GPU 表格上方增加 CPU 区间利用率：每个逻辑核心满载计 100%，显示折合满载核心数、逻辑核心总数与整机百分比。读取当前扩展宿主，支持取消与异常计数，只更新文字，避免闪烁。

## 0.1.35 - 2026-10-26

### Fixed / 修复

- Replace the native GPU hover with a persistent right-side WebviewView. Set HTML once and send samples as messages; update changed text only, preserve scrolling and keep controls stable. Hide/close pauses polling; reopening retains the view.
- GPU 改为右侧固定面板，HTML 仅初始化一次；每秒通过数据消息更新变化的文字，保持控件及滚动位置，避免整块卡片重建闪烁。隐藏/关闭时暂停，重新打开保留上次状态。
- Require VS Code 1.106+ for the stable Secondary Side Bar container. Keep remote-host sampling, timeouts, cancellation and single-refresh behavior; protect the view with a strict CSP, plain-text output and an action allowlist.
- 右侧视图使用正式 API，最低要求 VS Code 1.106；保留远程主机、超时、取消和单次刷新，使用严格 CSP、纯文字输出及动作白名单。

## 0.1.34 - 2026-10-26

### Added / 新增

- Add a bottom-right GPU button with a native live `nvidia-smi` table. Start on click, sample one second after each completed read, preserve columns with scrolling, and provide pause/resume and single-refresh controls.
- 新增右下角 GPU 按钮，在原生悬浮卡片显示完整 `nvidia-smi` 表格；点击后启动，每轮读取完成 1 秒后再刷新，保留列宽并支持滚动，提供暂停、继续和单次刷新。
- Execute on the current local/remote extension host, with PATH/custom executable discovery and Windows driver-directory fallbacks. Avoid shells and persistent watch processes; enforce timeout/output limits, cancellation, trust and non-overlapping commands. Closing the card keeps sampling; pause, disable or close the window to stop.
- 在当前本地/远程扩展宿主执行，支持 PATH、自定义工具路径和 Windows 常见驱动目录；不运行 shell 或常驻 watch，提供超时、输出限制、取消、工作区信任和非并发保护。收起卡片后继续采样，暂停、关闭功能或窗口时停止。

## 0.1.33 - 2026-10-24

### Added / 新增

- Cache current subscription DNS on the Linux/WSL extension host on discovery and every five days. Background work only saves DNS policy, uses private files isolated by runtime and source identity, retains stale data offline and limits failed refresh retries to hourly.
- 当前订阅 DNS 首次识别时及每 5 天缓存到所在 Linux/WSL 主机；后台仅缓存，按运行目录和订阅身份隔离，使用私有权限，离线保留旧数据，失败最多每小时重试一次。
- Manual subscription-DNS recovery tries a fresh 15-second download before using the matching cache. Apply DNS without depending on native node/rule downloads; retain nodes, rules, host DNS listeners, backups, verification, rollback and service state, and report cache download time.
- 手动应用优先尝试下载（15 秒），失败使用匹配缓存；无需原生更新下载节点或规则即可恢复 DNS，保留节点、规则、本机 DNS 监听、备份、核验、失败恢复和代理开关，显示缓存下载时间。

## 0.1.32 - 2026-10-23

### Changed / 变更

- Refresh Codex quotas every 120 seconds (two minutes) by default. Preserve existing custom settings, startup checks, retries and manual refresh; other feature intervals remain unchanged.
- Codex 额度默认每 120 秒（2 分钟）刷新，保留已有自定义设置、启动刷新、失败重试和手动刷新，其他功能的间隔保持不变。

## 0.1.31 - 2026-10-22

### Changed / 变更

- Successful subscription updates immediately refresh the host Google probe, current-node/subscription state and all loaded node delays with five concurrent tests. Discard old batch results and cancel stale host requests without changing periodic schedules or automatically selecting nodes.
- 更新订阅成功后立即刷新扩展宿主 Google 联网、当前节点/订阅状态和全部已加载节点延迟，最多 5 个并行；清除旧结果，取消旧联网请求后重测，不改变定时频率或自动切换节点。
- Keep refreshes independent, retain the control-operation guard until refreshes finish and preserve a stopped proxy. Failed updates do not start a full refresh; later test errors do not roll back a successful subscription update.
- 联网与节点检测独立执行，刷新期间保持操作互斥，关闭的代理保持关闭。更新失败不启动全量检测，后续检测失败不撤销已成功的订阅更新。

## 0.1.30 - 2026-10-22

### Added / 新增

- Add Test and Select Best Clash Node to the existing hover and command palette. Run a fresh five-at-a-time Google delay batch, choose the lowest successful delay reachable through the current group's manual selectors, prefer the current final node on ties, apply nested selections inside out and verify the effective final node.
- 原悬浮卡片和命令面板新增“测速并切换最佳节点”：重新执行最多 5 个并行的 Google 延迟测试，在当前策略组的手动选择链范围内取最低成功延迟，同延迟优先当前最终节点，内层到外层切换并核验实际节点。
- Preserve choices on total candidate failure or testing cancellation; detect changed modes/groups/manual choices before switching and attempt recovery of own writes after failure. Report outcomes in the existing hover and status bar. Do not alter routing mode, subscription data, DNS or test-only/automatic behavior.
- 候选全部失败或测速取消时保留原选择，切换前核对模式、策略组和手动选择，失败尝试恢复本次写入；在原悬浮卡片和状态栏报告结果。不改路由模式、订阅、DNS，原纯测速及自动任务行为不变。

## 0.1.29 - 2026-10-22

### Added / 新增

- Test all concrete nodes loaded by Clash/Mihomo with five concurrent Google delay requests, excluding groups and built-in Direct/Reject types. Add manual test/cancel actions to the existing hover and command palette; show timestamped sorted results and latency in the node picker. No selection writes; existing five-minute automatic current-node tests remain unchanged.
- 新增全部节点并行测速，最多同时进行 5 个 Google 延迟请求，排除策略组和 DIRECT/REJECT 等内置类型。原悬浮卡片和命令面板提供测速/取消入口，按延迟显示带时间的结果，节点选择列表显示本轮延迟。不切换当前节点，原有每 5 分钟当前节点自动测速保持不变。
- Abort pending requests and stop queueing on cancellation, disabling or disposal; deduplicate repeated starts and discard results after configuration/subscription changes or changed node lists.
- 支持取消、禁用或退出时终止等待请求与排队，重复点击复用同一轮任务，配置/订阅变更或节点列表变化后清除旧结果。

## 0.1.28 - 2026-10-22

### Added / 新增

- Add Use Subscription DNS and Restore Clash DNS Overrides to the existing native hover and command palette for Linux/WSL. Preserve host DNS enable/listen/IPv6 and unrelated settings, update and verify the source policy, isolate per-host mixins, create private backups and recover on configuration failures. Native updates continue using the cleaned Mixin; plugin start/update actions reapply and verify the opted-in policy.
- Linux/WSL 的原生悬浮卡片和命令面板新增 DNS 使用订阅配置、恢复原 DNS 覆写。保留本机 DNS 启用、监听、IPv6 和其他设置，更新核验来源策略，隔离按主机 Mixin，私有备份并支持配置失败恢复；原生更新继续使用清理后的 Mixin，插件启动/更新会再次应用核验已启用的策略。
- Report an independent full Google webpage download through the current local proxy, using curl without credentials; attempt supported DNS-cache flush after reload. Distinguish successful DNS application from webpage failure or skipped testing, preserving a stopped service.
- 独立报告经当前本机代理下载 Google 完整网页的结果，使用 curl，不携带登录凭据；加载后尝试清理内核 DNS 缓存。明确区分 DNS 应用成功、网页访问失败和未检测，关闭的代理保持关闭。

## 0.1.27 - 2026-10-21

### Changed / 变更

- Refresh Codex quotas every three minutes by default (180 seconds). Preserve startup checks, retries, manual refresh and configured overrides. Claude retains its fifteen-minute default.
- Codex 额度默认刷新间隔改为 3 分钟（180 秒），保留启动刷新、失败重试、手动刷新和已有自定义设置；Claude 默认间隔仍为 15 分钟。

## 0.1.26 - 2026-10-21

### Changed / 变更

- List configured Codex APIs directly alongside official ChatGPT login. Display the provider ID, configured name and current selection; clicking an existing API requires no ID, address or credential input. Keep manual ID entry and first-use setup as a fallback, reread configuration each time the menu opens, and preserve shared history and backup behavior.
- 服务商菜单直接列出已配置的 `beeapi` 等 API，与官方 ChatGPT 并列，展示 ID、配置名称和当前选择；直接点击，无需重复输入 ID、地址或密钥。保留手动输入和首次配置备用入口，每次打开菜单读取最新配置，历史共用与备份机制保持不变。

## 0.1.25 - 2026-10-21

### Added / 新增

- Switch Codex between official ChatGPT login and a manually entered custom API provider ID. Reuse configured providers or enter a Base URL and masked API Key for a new one. Add a dedicated status item, quota-hover action, command and Python-path setting.
- 新增官方 ChatGPT 与自定义 API 服务商切换：输入 `model_provider` 对应 ID（如 `beeapi`），复用已有配置，新 ID 提示填写地址和隐藏输入的 API Key；提供独立状态项、额度悬浮入口、命令和 Python 路径设置。
- Make all indexed local histories available to the chosen provider on each explicit switch. Back up configuration and live SQLite indexes, retain five successful snapshots, lock across windows, and recover provider labels/configuration on errors. Preserve transcript bytes, pagination offsets, archives, ordering and login files. Reload VS Code after switching; Python 3.8+ with sqlite3 is required in the extension host.
- 每次明确切换后，将全部已索引本地历史共用给所选服务商；自动备份配置与 SQLite 索引，保留最近五次成功备份，跨窗口加锁并支持失败恢复；保留聊天正文、分页偏移、归档、排序和登录文件。切换后重新加载窗口，扩展宿主需要 Python 3.8+（含 sqlite3）。
- Update both homepages with the complete feature set, provider workflow, requirements, backup behavior, commands and settings.
- GitHub 和插件市场的中英文主页更新全部功能、服务商操作流程、环境要求、备份行为、命令与设置。

## 0.1.24 - 2026-10-21

### Added / 新增

- Add Start Clash Proxy, Stop Clash Proxy and Update Current Clash Subscription to the existing native hover and command palette. Use native on/off/sub-update commands, including legacy shell integrations; keep start available while stopped.
- 新增开启代理、关闭代理和更新当前订阅，入口位于现有原生悬浮卡片和命令面板；调用安装中的原生命令，兼容旧版 Shell 管理脚本，关闭后仍可一键开启。
- Updating forces a running controller to load the generated configuration and verifies its nodes, preserves surviving manual selections and subscription sources, and restores the previous state on failure. Updates while stopped leave the proxy stopped.
- 更新会让运行中的 Clash 强制加载新配置并核对实际节点，保留仍可用的手动节点和订阅来源，失败尝试恢复；关闭时更新后保持关闭。修复原生命令只生成配置但旧进程仍在使用旧节点的问题。

## 0.1.23 - 2026-10-19

### Fixed / 修复

- Recognize custom clash-for-linux installations with per-host `runtime/hosts/<hostname>` state. Keep subscription reads, locks, writes and recovery in the running core's own directory; verify the native scripts use the same runtime before managing subscriptions or controlling the service.
- 修复集群按主机隔离 `runtime/hosts/<主机名>` 时无法添加订阅的问题。自动推断自定义安装目录，订阅读取、锁、写入与失败恢复使用当前运行目录，执行原生命令前核对目录，防止误操作全局或其他节点的订阅。

## 0.1.22 - 2026-10-17

### Documentation / 文档

- Expand the English and Chinese homepages with the complete feature overview, setup, Codex/Claude quotas, separate five-hour connectivity and five-minute Clash schedules, node and subscription operations, file-link recovery, all commands, settings and diagnostics.
- 中英文主页补齐全部功能总览、使用步骤、Codex/Claude 额度、五小时联网检测与五分钟 Clash 测速、节点和订阅操作、文件链接补开、所有命令、设置与诊断。

## 0.1.21 - 2026-10-17

### Changed / 变更

- Check Google connectivity from the VS Code extension host at startup and every five hours by default (18000 seconds), while preserving manual checks and the independent Clash node-test interval.
- VS Code 扩展宿主的 Google 联网检测改为启动时检测一次、之后默认每 5 小时（18000 秒）一次；保留手动检测，Clash 节点测速间隔保持独立。

## 0.1.20 - 2026-10-17

### Changed / 变更

- Change extension-host connectivity detection to the Google public website. Any HTTP response counts as connected; stop at headers without following redirects. Merge the result into a single ✅️ / ❌ prefix before the existing Clash globe instead of a separate ChatGPT status item; keep details and manual detection in the shared hover.
- 将扩展宿主联网检测改为只访问 Google 公开网页，收到任意 HTTP 响应即视为连通，不下载页面或跟随跳转。移除独立 ChatGPT 状态项，在原有 Clash 地球图标前只显示 ✅️ / ❌，详情和立即检测入口合并到原生悬浮卡片。

## 0.1.19 - 2026-10-16

### Added / 新增

- Add an independent ChatGPT public-website connectivity check from the current VS Code extension host, at startup and every five minutes. Show HTTP restrictions, browser challenges and network errors separately, with a native hover card and manual refresh. No login credentials, API keys or authenticated API requests are needed.
- 新增独立的 ChatGPT 公开网页联网检测，在当前 VS Code 扩展宿主启动时及每五分钟执行。区分网页访问成功、HTTP 受限、人机验证和网络故障；支持右下角原生悬浮卡片与立即检测，无需登录、API Key 或鉴权 API。

## 0.1.18 - 2026-10-16

### Changed / 变更

- Clicking the Clash status bar now opens its existing hover card above the status bar, with current-node, Google latency and subscription actions.
- 点击 Clash 状态栏立即展开右下角原有的悬浮卡片，显示当前节点、Google 延迟及订阅操作。

## 0.1.17 - 2026-10-16

### Changed / 变更

- Allow confirmed removal of every subscription, including `default`. Verify the next enabled source before removing the active source, preserve connections when removing inactive sources, and stop Clash when no enabled replacement remains. The final removal clears active state; adding and switching can start Clash again.
- 所有订阅（包括 `default`）均可删除：删除当前订阅前先切换并验证下一个已启用订阅，删除非当前订阅保留连接，无可用备用订阅时停止 Clash；最后一个删除后清空活动状态，重新添加并切换可再次启动。

## 0.1.16 - 2026-10-16

### Changed / 变更

- Clicking the Clash status bar opens a persistent details page with current nodes, Google latency and subscription actions. The hover remains available, and changes refresh the open details page.
- 点击 Clash 状态栏打开固定详情页，显示当前节点、Google 延迟和订阅管理；保留悬停操作，状态变化同步更新详情页。
- Show every subscription in the removal picker. Mark the native `default` subscription as protected and explain the restriction when selected instead of hiding it.
- 删除列表显示所有订阅；原生 `default` 订阅标注不可删除，点击时说明限制，不再直接隐藏。

## 0.1.15 - 2026-10-16

### Changed / 变更

- Add Clash subscriptions by pasting only the URL. Detect the provider name from response headers, fall back to the hostname, and generate a safe, unique native name without replacing existing subscriptions.
- 添加 Clash 订阅时只需粘贴链接，自动从响应头识别名称，读取失败时使用域名；自动处理名称格式和重名，避免覆盖已有订阅。

## 0.1.14 - 2026-10-16

### Added / 新增

- Add confirmed Clash subscription removal from the status-bar hover and command palette. The native `default` subscription cannot be removed.
- 新增状态栏悬停菜单和命令面板中的 Clash 订阅删除功能，删除前确认；原生 `default` 订阅不可删除。

## 0.1.13 - 2026-10-15

### Fixed / 修复

- Discover running Linux/WSL Clash/Mihomo configs from process arguments before common paths; support literal command launchers, shell integration and environment hints without executing shell startup files. Custom installation paths no longer require per-host settings in typical deployments.
- Linux/WSL 优先从运行进程的 -f/-d 参数识别 Clash/Mihomo 配置，兼容命令入口、shell 登记路径和环境变量；不执行 shell 启动脚本。通常无需因自定义安装目录而逐台填写设置。
- Preserve explicit overrides, honor installDirectory for connection discovery, and rediscover restarted or moved cores on refresh. Subscription management follows the detected runtime configuration.
- 保留手动配置优先级，installDirectory 同时用于连接发现；刷新重新识别重启或迁移的服务，订阅管理沿用自动发现的运行目录。

## 0.1.12 - 2026-10-15

### Changed / 变更

- Resized the Marketplace icon to 512 × 512 to meet its 1 MB limit. / 将市场图标缩小为 512 × 512，以满足 1 MB 大小限制。
- Subscription picker labels now use provider names from profile-title or Content-Disposition headers, with source hostnames as fallback. Details retain native identifiers and source hosts; hover uses cached names.
- 切换订阅时自动读取服务提供的名称（profile-title 或文件名），读取失败时显示来源域名；同时保留原标识和来源信息，悬停复用已识别的名称。
- Metadata is requested only when opening the subscription picker, stops after response headers, and is cached in memory for one hour (five minutes on failure). Full private URLs stay out of displayed metadata and logs.
- 仅打开订阅列表时请求名称，收到响应头后停止读取；名称在内存缓存一小时，失败缓存五分钟，完整私密链接不进入显示信息和日志。

## 0.1.11 - 2026-10-15

### Changed / 变更

- Changed the default Clash automatic refresh and latency-test interval from 60 to 300 seconds (5 minutes). Manual refreshes and node or subscription switches still test immediately.
- 将 Clash 默认自动刷新和测速间隔从 60 秒改为 300 秒（5 分钟）；手动刷新及切换节点或订阅后仍立即测速。

## 0.1.10 - 2026-10-15

### Added / 新增

- Add and switch clash-for-linux subscriptions from status-bar hover or commands. Saving can keep the active connection; switching uses the native service workflow and attempts to restore the previous subscription and manual nodes on failure.
- 新增 clash-for-linux 订阅添加、仅保存或立即切换、当前订阅显示，以及切换失败后的原订阅和手动节点恢复。
- Private URLs stay in the native subscription file; masked inputs, no URL command arguments or plugin logging, duplicate-name checks and a cross-window mutation lock.
- 订阅链接只保存在原生订阅文件；输入隐藏，不进入命令参数或插件日志，并增加重名校验及跨窗口操作互斥。

## 0.1.9 - 2026-10-15

### Added / 新增

- Added Clash/Mihomo Google latency in the status bar, final-node hover details, direct node links and a searchable switcher. Switching verifies the controller's selection and refreshes latency.
- 新增 Clash/Mihomo 状态栏 Google 延迟、悬停最终节点与选择链、可点击的节点切换和完整搜索列表；切换后校验结果并刷新延迟。
- Auto-discovers controller credentials in the current extension host's YAML configuration, supports Remote SSH and rule/global/direct modes, and provides refresh/configuration/diagnostic controls.
- 从当前扩展宿主的 YAML 自动识别控制器和密钥，支持 Remote SSH、规则/全局/直连模式，以及刷新、配置和诊断。

## 0.1.8 - 2026-09-30

### Changed / 变更

- Removed `.txt` from the default `code -r` recovery formats; users can still add it explicitly in `agentStatus.codexImageLinks.extensions`.
- 从默认 `code -r` 补开格式中移除 `.txt`；如需使用，仍可在 `agentStatus.codexImageLinks.extensions` 中显式加入。

## 0.1.7 - 2026-09-29

### Added / 新增

- Expanded `code -r` recovery to 31 default extensions: existing images/PDF/SVG plus Markdown, CSV/TSV, HTML, notebooks, LaTeX/BibTeX, text/configuration files (including TOML), and Office documents. Files follow VS Code's default editor; PDF/Office previews need suitable viewer extensions.
- 将 `code -r` 补开范围扩展到 31 种默认扩展名：保留图片/PDF/SVG，新增 Markdown、CSV/TSV、HTML、Notebook、LaTeX/BibTeX、普通文本与配置（含 TOML），以及 Office 文档。文件遵循 VS Code 默认编辑器设置，PDF/Office 预览需要相应查看器扩展。
- Added `agentStatus.codexImageLinks.extensions` to configure both failure-log and text-tab recovery. Text-tab detection continues to apply to all sources; disable it with `reopenTextDocuments` or remove individual formats from the list.
- 新增 `agentStatus.codexImageLinks.extensions`，统一配置日志与文本标签页补开的格式。文本标签页检测仍适用于所有来源，可通过 `reopenTextDocuments` 关闭或从列表移除特定格式。

### Fixed / 修复

- Preserved native notebook tabs and prevented repeated reopening when a slow CLI launch returns a text editor, including Markdown, CSV, TOML, and other text formats.
- 保留原生 Notebook 标签页，并防止 CLI 启动较慢、返回 Markdown、CSV、TOML 等文本编辑器时反复重开。

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
