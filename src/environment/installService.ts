import * as vscode from 'vscode';
import { findOnPath } from '../core/paths';

interface InstallRecipe {
  title: string;
  command: string;
  manualOnly?: boolean;
}

export class InstallService {
  constructor(
    private readonly locale: () => 'zh-cn' | 'en',
    private readonly onTerminalClosed: () => void
  ) {}

  async install(tool: 'cortex' | 'gdb' | 'openocd', rebuild = false): Promise<void> {
    if (tool === 'cortex') {
      await vscode.commands.executeCommand('workbench.extensions.installExtension', 'marus25.cortex-debug');
      return;
    }
    const recipe = await this.recipe(tool, rebuild);
    if (recipe.manualOnly) {
      await vscode.window.showWarningMessage(`${recipe.title}\n\n${recipe.command}`, { modal: true });
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${recipe.title}\n\n${recipe.command}`,
      { modal: true },
      localized(this.locale(), 'Run in Terminal', '在终端中运行')
    );
    if (choice !== localized(this.locale(), 'Run in Terminal', '在终端中运行')) {
      return;
    }
    const terminalOptions: vscode.TerminalOptions = {
      name: localized(this.locale(), `AmphiLink CFG Tool: Install ${tool}`, `AmphiLink CFG Tool：安装 ${tool}`)
    };
    if (process.platform === 'win32' && tool === 'openocd') {
      terminalOptions.shellPath = 'powershell.exe';
      terminalOptions.shellArgs = ['-NoLogo', '-NoProfile'];
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    const disposable = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        disposable.dispose();
        this.onTerminalClosed();
      }
    });
    terminal.show();
    terminal.sendText(recipe.command, true);
  }

  private async recipe(tool: 'gdb' | 'openocd', rebuild: boolean): Promise<InstallRecipe> {
    const zh = this.locale() === 'zh-cn';
    if (process.platform === 'darwin') {
      return tool === 'gdb'
        ? { title: zh ? '是否使用 Homebrew 安装 GNU Arm GDB 和 binutils？' : 'Install GNU Arm GDB and binutils with Homebrew?', command: 'brew install arm-none-eabi-gdb arm-none-eabi-gcc' }
        : {
            title: zh ? '是否使用 Homebrew 构建当前 OpenOCD development version？' : 'Build the current OpenOCD development version with Homebrew?',
            command: rebuild ? 'brew reinstall --HEAD open-ocd' : 'brew install --HEAD open-ocd'
          };
    }
    if (process.platform === 'win32') {
      return tool === 'gdb'
        ? {
            title: zh ? '是否使用 winget 安装 GNU Arm Embedded Toolchain？' : 'Install the GNU Arm Embedded Toolchain with winget?',
            command: 'winget install --id Arm.GnuArmEmbeddedToolchain --exact --accept-package-agreements --accept-source-agreements'
          }
        : {
            title: zh ? '是否下载并安装 OpenOCD Windows 预发布版？' : 'Download and install the OpenOCD Windows prerelease?',
            command: [
              '$ErrorActionPreference = "Stop"',
              '$url = "https://github.com/openocd-org/openocd/releases/download/latest/openocd-56b8d93-i686-w64-mingw32.tar.gz"',
              '$archive = Join-Path $env:TEMP "openocd-latest.tar.gz"',
              '$install = "C:\\OpenOCD"',
              'Invoke-WebRequest -Uri $url -OutFile $archive',
              'New-Item -ItemType Directory -Force -Path $install | Out-Null',
              'tar.exe -xzf $archive -C $install',
              'Remove-Item $archive',
              '& "$install\\bin\\openocd.exe" --version'
            ].join('\n')
          };
    }
    return tool === 'gdb' ? this.linuxGdbRecipe(zh) : this.manualOpenOcdRecipe(zh);
  }

  private async linuxGdbRecipe(zh: boolean): Promise<InstallRecipe> {
    if (await findOnPath('apt-get')) {
      return { title: zh ? '是否使用 apt 安装 GNU Arm 工具？' : 'Install GNU Arm tools with apt?', command: 'sudo apt-get update\nsudo apt-get install -y gcc-arm-none-eabi binutils-arm-none-eabi gdb-multiarch' };
    }
    if (await findOnPath('dnf')) {
      return { title: zh ? '是否使用 dnf 安装 GNU Arm 工具？' : 'Install GNU Arm tools with dnf?', command: 'sudo dnf install -y arm-none-eabi-gcc-cs arm-none-eabi-binutils-cs arm-none-eabi-gdb' };
    }
    if (await findOnPath('pacman')) {
      return { title: zh ? '是否使用 pacman 安装 GNU Arm 工具？' : 'Install GNU Arm tools with pacman?', command: 'sudo pacman -S --needed arm-none-eabi-gcc arm-none-eabi-binutils arm-none-eabi-gdb' };
    }
    return { title: zh ? '是否使用 zypper 安装 GNU Arm 工具？' : 'Install GNU Arm tools with zypper?', command: 'sudo zypper install cross-arm-none-gcc cross-arm-none-binutils cross-arm-none-gdb' };
  }

  private async manualOpenOcdRecipe(zh: boolean): Promise<InstallRecipe> {
    return {
      title: zh ? 'Linux 需要手动构建 OpenOCD master 最新提交。' : 'Linux requires a manual build of the latest OpenOCD master commit.',
      command: zh
        ? '请从 OpenOCD master 最新提交构建，并启用 --enable-cmsis-dap-tcp。构建完成后，使用路径按钮选择 openocd 和 scripts 目录，再重新检查环境。'
        : 'Build the latest OpenOCD master commit with --enable-cmsis-dap-tcp. After the build, use the path buttons to select openocd and the scripts directory, then check the environment again.',
      manualOnly: true
    };
  }
}

function localized(locale: 'zh-cn' | 'en', english: string, chinese: string): string {
  return locale === 'zh-cn' ? chinese : english;
}
