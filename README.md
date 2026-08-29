# AmphiLink CFG Tool

AmphiLink CFG Tool 是用于发现、连接和配置 AmphiLink 调试器的 VS Code 扩展，支持 Windows、macOS 和 Linux。扩展在 Activity Bar 提供独立侧边栏，用于检查调试环境、发现 USB/局域网/热点设备，并为当前嵌入式工程生成 Cortex-Debug 配置。

## 使用

1. 点击 Activity Bar 中的 AmphiLink CFG Tool 图标，打开“环境检查”并等待检查完成。
2. 对缺失工具使用安装按钮或路径按钮。点击安装按钮后会提示安装方法或在得到确认后执行安装命令。
3. 打开“设备连接”并刷新。扩展依次检查 USB AmphiLink、局域网无线广播和 `AmphiLink-*` 热点。热点需要手动连接后访问 `http://192.168.4.1/`进行配置。
4. 选择有线设备或可达的无线设备，在“调试配置”中确认目标芯片、target config、ELF 和调试速度，然后点击“为当前项目保存”。选择无线设备后可以在下半部“无线串口”中连接 TCP 串口并收发数据。
5. 打开 VS Code 的 Run and Debug 视图，选择生成的 AmphiLink Cortex-Debug 配置。

### 无线串口

固件在 Wi-Fi STA 模式下通过 TCP `4443` 提供 UART-over-TCP 原始字节流。选择可达的无线设备后扩展会自动连接该端口；切换设备或选择有线设备时会断开连接。无线串口面板支持独立的 ASCII 文本、十六进制和二进制接收显示及发送格式，十六进制和二进制发送会按连续数字流解析。

波特率、数据位、校验位和停止位是固件 UART 的硬件参数，不属于 TCP 客户端配置。请通过“无线串口”面板中的“打开配置网页”按钮进入设备网页进行修改。

### 环境要求

- VS Code 扩展 `marus25.cortex-debug`。
- GDB 工具组中的 `gdb`、`objdump` 和 `nm`。可以自动搜索常见路径，如无符合要求的程序，本扩展会在得到确认后通过命令安装。
- 支持 CMSIS-DAP TCP backend （如果需要使用无线模式）的 OpenOCD。扩展会实际执行 `adapter driver cmsis-dap`、`cmsis-dap backend tcp`、host、port、`min_timeout` 和 `shutdown` 命令以确认候选的OpenOCD能力。

工具按以下顺序逐个搜索并立即验证：AmphiLink CFG Tool 设置、Cortex-Debug 本平台设置、Cortex-Debug 通用设置、系统 `PATH`、包管理器目录、常见默认安装目录、STM32Cube 目录。GDB 还会检查同目录或 PATH 中配套的 `objdump` 和 `nm`；候选不兼容时会继续检查更低优先级路径。

如果只找到具备完整 scripts 和有线 CMSIS-DAP 能力、但不支持 TCP backend 的 OpenOCD，环境检查会标记为“仅有线可用”。有线设备仍可刷新和生成配置；选择无线设备时会进行提示并禁止保存无线配置。macOS 提供一键构建按钮，Windows 提供一键安装预发布版按钮，Linux 需要手动构建并启用 `--enable-cmsis-dap-tcp`。

macOS 可由本扩展在得到确认后通过 `brew install --HEAD open-ocd` 构建 OpenOCD master 最新提交；已安装不符合要求的版本时，一键构建使用 `brew reinstall --HEAD open-ocd`。Windows会在得到确认后执行下载预发布版命令。Linux 不会由扩展自动下载或构建 OpenOCD；请自行构建 master 最新提交并启用 `--enable-cmsis-dap-tcp`，然后在扩展中选择生成的可执行文件和 scripts 目录。

### 工程识别

STM32CubeMX 生成的 CMake 工程优先。扩展解析 `.ioc`、`CMakePresets.json`、CMake File API 和 CMake 输出；例如 `STM32F407VET6` 会映射到 `target/stm32f4x.cfg`，并从 `build/Debug` 推导 ELF。其他工程依次尝试现有 Cortex-Debug/OpenOCD 配置、通用 CMake、PlatformIO 和工作区 ELF 扫描。

多个 ELF 或 target config 候选会要求确认。无法自动识别时，可以在“调试配置”中直接输入或浏览选择。ELF 尚未生成、target config 不存在、环境不完整、未选择设备或未打开工作区时，保存操作会被阻止并显示修复提示。

## 配置生成

点击“为当前项目保存”会生成或更新：

- `.vscode/amphilink-cfg-openocd.cfg`：有线模式使用 CMSIS-DAP USB bulk、产品字符串 `AmphiLink (CMSIS-DAP V2)` 和 VID/PID `303A:83B3`；无线模式使用 TCP host、port `4441` 和 `min_timeout`。
- `.vscode/launch.json`：托管的 Cortex-Debug 配置，包含已验证的 OpenOCD、scripts、GDB、ELF、SVD（如可用）、SWD、adapter speed 和 `runToEntryPoint: main`。

## 面向开发者

运行时源码位于 `src/`，Webview 资源位于 `media/`。使用以下命令进行发布前检查和打包：

```sh
npm install
npm run check
npm run lint
npm run build
npm run package
```

## 开源仓库与反馈

- 源码仓库：[github.com/danjinghaoeggggg/AmphiLink_CFG_Tool](https://github.com/danjinghaoeggggg/AmphiLink_CFG_Tool)
- 许可证：MIT，详见 [`LICENSE`](LICENSE)。

---

# English

AmphiLink CFG Tool is a VS Code extension for discovering, connecting to, and configuring AmphiLink debuggers. It supports Windows, macOS, and Linux. The extension adds an Activity Bar view for checking the debug environment, discovering USB, LAN, and hotspot devices, and generating Cortex-Debug configuration for the current embedded project.

## Use

1. Open the AmphiLink CFG Tool view from the Activity Bar, select Environment, and wait for the check to finish.
2. Use the install or path buttons for missing tools. The extension shows the installation method and asks for confirmation before running an installation command.
3. Open Devices and refresh. The extension checks USB AmphiLink, LAN wireless broadcasts, and `AmphiLink-*` hotspots in that order. Connect to a hotspot manually before opening `http://192.168.4.1/` for configuration.
4. Select a wired device or a reachable wireless device. In Debug Configuration, confirm the target MCU, target config, ELF, and adapter speed, then choose Save for current project. When a wireless device is selected, use Wireless Serial in the lower panel to connect to TCP port `4443` and exchange data.
5. Open VS Code's Run and Debug view and select the generated AmphiLink Cortex-Debug configuration.

### Requirements

- The `marus25.cortex-debug` VS Code extension.
- The GDB tool group: `gdb`, `objdump`, and `nm`. The extension searches common locations automatically and, if no compatible tools are found, can run an installation command after confirmation.
- An OpenOCD build with the CMSIS-DAP TCP backend when wireless mode is required. The extension executes `adapter driver cmsis-dap`, `cmsis-dap backend tcp`, host, port, `min_timeout`, and `shutdown` commands to validate each candidate.

Tools are searched and validated one candidate at a time in this order: AmphiLink CFG Tool settings, the platform-specific Cortex-Debug setting, the generic Cortex-Debug setting, the system `PATH`, common package-manager directories, common default installation directories, and STM32Cube directories. GDB also validates companion `objdump` and `nm` tools from the same directory or `PATH`; incompatible candidates are skipped in favor of lower-priority candidates.

If the only usable OpenOCD has complete scripts and wired CMSIS-DAP support but no TCP backend, Environment reports “wired only”. Wired devices can still be scanned and configured. Selecting a wireless device shows a warning and blocks saving the wireless configuration. macOS offers a one-click build button, Windows offers a one-click prerelease installation button, and Linux requires a manual build with `--enable-cmsis-dap-tcp`.

On macOS, after confirmation, the extension can build the latest OpenOCD master commit with `brew install --HEAD open-ocd`; when an incompatible version is already installed, the one-click build uses `brew reinstall --HEAD open-ocd`. On Windows, after confirmation, the extension runs the prerelease download command in a PowerShell terminal. Linux does not download or build OpenOCD automatically; build the latest master commit yourself with `--enable-cmsis-dap-tcp`, then select the resulting executable and scripts directory in the extension.

#### Building the latest OpenOCD master commit

The following commands use the latest commit on OpenOCD's upstream master branch. See the [OpenOCD README](https://github.com/openocd-org/openocd/blob/master/README.md) for build requirements and optional dependencies.

macOS (Homebrew):

```sh
brew install --HEAD open-ocd
```

Linux (Debian/Ubuntu example):

```sh
sudo apt update
sudo apt install -y git build-essential autoconf automake libtool pkg-config texinfo libusb-1.0-0-dev libhidapi-dev
git clone --recurse-submodules https://github.com/openocd-org/openocd.git
cd openocd
./bootstrap
./configure --enable-cmsis-dap-tcp --prefix="$HOME/.local"
make -j"$(nproc)"
make install
```

Windows:

```sh
gcc --version
mingw32-make --version
autoconf --version
automake --version
libtoolize --version
pkg-config --exists libusb-1.0
git clone --recurse-submodules https://github.com/openocd-org/openocd.git
cd openocd
./bootstrap
./configure --enable-cmsis-dap-v2 --enable-cmsis-dap-tcp --prefix="/c/OpenOCD"
mingw32-make -j4
mingw32-make install
```

### Wireless serial

When Wi-Fi STA mode is active, the firmware exposes a raw UART-over-TCP service on TCP `4443`. Selecting a reachable wireless device connects the extension automatically; changing devices or selecting a wired device closes the connection. The Wireless Serial panel supports independent ASCII text, hexadecimal, and binary receive and send formats. Hexadecimal and binary sends are parsed as continuous digit streams.

Baud rate, data bits, parity, and stop bits are hardware UART settings, not TCP client settings. Use the Open configuration page button in the Wireless Serial panel to change them on the device.

### Project detection

STM32CubeMX-generated CMake projects have priority. The extension parses `.ioc`, `CMakePresets.json`, the CMake File API, and CMake output. For example, `STM32F407VET6` maps to `target/stm32f4x.cfg`, and the ELF is inferred from `build/Debug`. Other projects are checked using existing Cortex-Debug/OpenOCD configuration, generic CMake, PlatformIO metadata, and workspace ELF scanning.

When multiple ELF or target-config candidates exist, the extension asks for confirmation. Any uncertain result can be replaced by entering or browsing for a path in Debug Configuration. Saving is blocked when the ELF has not been built, the target config is missing, the environment is incomplete, no device is selected, or no workspace is open.

## Generated configuration

Save for current project creates or updates:

- `.vscode/amphilink-cfg-openocd.cfg`: CMSIS-DAP USB bulk with product string `AmphiLink (CMSIS-DAP V2)` and VID/PID `303A:83B3` for wired mode, or TCP host, port `4441`, and `min_timeout` for wireless mode.
- `.vscode/launch.json`: a managed Cortex-Debug configuration containing verified OpenOCD, scripts, GDB, ELF, an available SVD, SWD, adapter speed, and `runToEntryPoint: main`.

## For contributors

Runtime source is under `src/`, and Webview assets are under `media/`. Use the following commands for release checks and packaging:

```sh
npm install
npm run check
npm run lint
npm run build
npm run package
```

## Open source and feedback

- Source repository: [github.com/danjinghaoeggggg/AmphiLink_CFG_Tool](https://github.com/danjinghaoeggggg/AmphiLink_CFG_Tool)
- License: MIT, see [`LICENSE`](LICENSE).
