# Manual validation and full bundles

The normal automated tests are run with `npm run test:unit`. These scripts are additional developer tools and are not executed automatically when the extension starts or during unit tests.

- `clash-smoke.cjs`: after `npm run compile`, run `node scripts/clash-smoke.cjs` on a Clash host to inspect the discovered controller, Google delay and hover links. Passing `--switch` also temporarily selects the current final node directly and restores the original selector entry afterward; it requires a suitable manual selector.
- `subscription-smoke.cjs`: after compilation, pass a private Clash subscription URL on standard input on a compatible Linux/WSL host. The script saves a source named `new-subscription`, switches to it, checks connectivity, and restores the original active subscription and available manual choices. The new source remains saved. It keeps a private recovery configuration in the operating system's temporary directory until restoration is verified. This is an explicit live integration test, not a unit test; it is not needed to build or use the extension.
- `build-full-bundle.py`: after building the matching VSIX, run `python scripts/build-full-bundle.py` using Python 3.8+. It combines all committed project files, the VSIX's compiled runtime and production dependencies, and the VSIX itself into `vsix/Agent-Center-<version>-full.zip`. A `SOURCE-MANIFEST.json` records the source commit, file lists and VSIX SHA-256. The working tree must be committed, with no untracked files outside ignored build outputs. Use `--vsix` or `--output` to select other paths.

The smoke scripts read controller credentials from the existing host configuration; no subscription URLs or login credentials are embedded in the repository.

## 中文

常规自动测试运行 `npm run test:unit`。这些是额外的开发工具，不会随插件启动或单元测试自动执行。

- `clash-smoke.cjs`：编译后，在 Clash 主机运行 `node scripts/clash-smoke.cjs`，检查控制器发现、Google 延迟和悬浮卡片链接。只有显式传入 `--switch` 才临时切换到当前最终节点并恢复原选择，需要合适的手动策略组。
- `subscription-smoke.cjs`：编译后，在兼容的 Linux/WSL 主机通过标准输入提供订阅地址。它保存名为 `new-subscription` 的来源，切换并检查连通性，再恢复原活动订阅与仍可用的手动节点选择；新来源仍保留在订阅列表。恢复核验前，原配置备份保存在系统临时目录的私有文件夹中。这是显式实机测试，构建和使用插件无需运行。
- `build-full-bundle.py`：先构建同版本 VSIX，再用 Python 3.8+ 运行 `python scripts/build-full-bundle.py`。生成的 `vsix/Agent-Center-<版本>-full.zip` 包含全部已提交源码、VSIX 编译后的运行文件与生产依赖，以及 VSIX 安装包。`SOURCE-MANIFEST.json` 记录来源提交、文件列表和 VSIX 校验值。构建前提交工作区，未跟踪文件应提交或按需忽略；支持 `--vsix`、`--output` 指定路径。

实机脚本读取主机现有的控制器凭据，仓库不内嵌订阅地址和登录凭据。
