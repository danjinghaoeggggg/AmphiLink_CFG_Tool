import { readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { acceptsOpenOcdTcpProbe, acceptsOpenOcdUsbProbe, openOcdTcpProbeArgs, openOcdUsbProbeArgs } from '../core/openocd';
import { expandHome, findAllOnPath, firstExecutable, isDirectory, isExecutable, walkFiles } from '../core/paths';
import { processOutput, runProcess } from '../core/process';
import type { EnvironmentStatus, ToolProbeResult } from '../types';

interface ToolCandidate {
  path: string;
  source: string;
  priority: number;
}

const EXCLUDED_SCAN_DIRECTORIES = new Set(['.git', 'node_modules', 'sources', 'src']);

function emptyProbe(id: ToolProbeResult['id'], label: string): ToolProbeResult {
  return { id, label, state: 'idle', details: [] };
}

export function initialEnvironmentStatus(): EnvironmentStatus {
  return {
    checking: false,
    cortex: emptyProbe('cortex', 'Cortex-Debug'),
    gdb: emptyProbe('gdb', 'GNU Arm GDB'),
    openocd: emptyProbe('openocd', 'OpenOCD'),
    complete: false
  };
}

export class EnvironmentService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async check(onProgress?: (status: EnvironmentStatus) => void): Promise<EnvironmentStatus> {
    const status = initialEnvironmentStatus();
    status.checking = true;
    onProgress?.(structuredClone(status));

    status.cortex = await this.probeCortex();
    onProgress?.(structuredClone(status));
    status.gdb = await this.probeGdb();
    onProgress?.(structuredClone(status));
    status.openocd = await this.probeOpenOcd();
    status.checking = false;
    status.complete = status.cortex.state === 'ready'
      && status.gdb.state === 'ready'
      && status.openocd.capabilities?.wired === true;
    status.checkedAt = new Date().toISOString();
    onProgress?.(structuredClone(status));
    return status;
  }

  private async probeCortex(): Promise<ToolProbeResult> {
    const extension = vscode.extensions.getExtension('marus25.cortex-debug');
    if (!extension) {
      return {
        id: 'cortex', label: 'Cortex-Debug', state: 'missing', details: [],
        error: 'VS Code extension marus25.cortex-debug is not installed.'
      };
    }
    return {
      id: 'cortex', label: 'Cortex-Debug', state: 'ready', path: extension.extensionPath,
      version: String(extension.packageJSON.version ?? ''), source: 'VS Code', details: []
    };
  }

  private async probeGdb(): Promise<ToolProbeResult> {
    const executable = platformExecutable('arm-none-eabi-gdb');
    const configuration = vscode.workspace.getConfiguration('amphilinkCfg');
    const cortex = vscode.workspace.getConfiguration('cortex-debug');
    const platformKey = cortexPlatformKey();
    let firstFailure: ToolProbeResult | undefined;
    const visited = new Set<string>();
    const groups: Array<() => Promise<ToolCandidate[]>> = [
      async () => this.explicitCandidates([[configuration.get<string>('gdbPath'), 'AmphiLink CFG Tool setting']], 1),
      async () => this.explicitCandidates([
        [cortex.get<string>(`gdbPath.${platformKey}`), `Cortex-Debug ${platformKey} gdbPath`],
        [toolchainExecutable(cortex.get<string>(`armToolchainPath.${platformKey}`), executable), `Cortex-Debug ${platformKey} armToolchainPath`]
      ], 2),
      async () => this.explicitCandidates([
        [cortex.get<string>('gdbPath'), 'Cortex-Debug gdbPath'],
        [toolchainExecutable(cortex.get<string>('armToolchainPath'), executable), 'Cortex-Debug armToolchainPath']
      ], 3),
      async () => this.pathCandidates(['arm-none-eabi-gdb', 'gdb-multiarch'], 4),
      async () => this.gdbPackageManagerCandidates(executable),
      async () => this.gdbDefaultCandidates(executable),
      async () => this.gdbStm32CubeCandidates(executable)
    ];

    for (const group of groups) {
      for (const candidate of await group()) {
        const normalized = normalizeCandidate(candidate.path);
        if (visited.has(normalized) || !(await isExecutable(normalized))) {
          continue;
        }
        visited.add(normalized);
        const result = await this.probeGdbCandidate({ ...candidate, path: normalized });
        if (result.state === 'ready') {
          return result;
        }
        firstFailure ??= result;
      }
    }

    return firstFailure ?? {
      id: 'gdb', label: 'GNU Arm GDB', state: 'missing', details: [],
      error: 'arm-none-eabi-gdb or gdb-multiarch was not found.'
    };
  }

  private async probeGdbCandidate(candidate: ToolCandidate): Promise<ToolProbeResult> {
    const versionResult = await runProcess(candidate.path, ['--version'], { timeoutMs: 5000 });
    const version = firstLine(processOutput(versionResult));
    if (versionResult.code !== 0) {
      return {
        id: 'gdb', label: 'GNU Arm GDB', state: 'error', path: candidate.path,
        source: candidate.source, version, details: [`Search priority: ${candidate.priority}`],
        error: versionResult.error ?? (processOutput(versionResult) || 'GDB version check failed.')
      };
    }

    const directory = path.dirname(candidate.path);
    const multiarch = path.basename(candidate.path).toLowerCase().startsWith('gdb-multiarch');
    const companionPrefix = multiarch ? '' : 'arm-none-eabi-';
    const objdump = await this.findCompanion(directory, `${companionPrefix}objdump`, 'arm-none-eabi-objdump', 'objdump');
    const nm = await this.findCompanion(directory, `${companionPrefix}nm`, 'arm-none-eabi-nm', 'nm');
    const missing = [!objdump && 'objdump', !nm && 'nm'].filter((value): value is string => Boolean(value));
    if (missing.length) {
      return {
        id: 'gdb', label: 'GNU Arm GDB', state: 'incompatible', path: candidate.path,
        source: candidate.source, version, details: [`Search priority: ${candidate.priority}`],
        error: `Required companion tools are missing: ${missing.join(', ')}`
      };
    }

    const companionChecks = await Promise.all([
      runProcess(objdump!, ['--version'], { timeoutMs: 5000 }),
      runProcess(nm!, ['--version'], { timeoutMs: 5000 })
    ]);
    if (companionChecks.some((result) => result.code !== 0)) {
      return {
        id: 'gdb', label: 'GNU Arm GDB', state: 'incompatible', path: candidate.path,
        source: candidate.source, version, details: [`Search priority: ${candidate.priority}`],
        error: 'A required objdump or nm companion tool failed its version check.'
      };
    }

    return {
      id: 'gdb', label: 'GNU Arm GDB', state: 'ready', path: candidate.path,
      source: candidate.source, version,
      details: [`Search priority: ${candidate.priority}`, `objdump: ${objdump}`, `nm: ${nm}`]
    };
  }

  private async findCompanion(directory: string, localName: string, armName: string, nativeName: string): Promise<string | undefined> {
    return firstExecutable([
      path.join(directory, platformExecutable(localName)),
      ...(await findAllOnPath(armName)),
      ...(await findAllOnPath(nativeName))
    ]);
  }

  private async probeOpenOcd(): Promise<ToolProbeResult> {
    const executable = platformExecutable('openocd');
    const configuration = vscode.workspace.getConfiguration('amphilinkCfg');
    const cortex = vscode.workspace.getConfiguration('cortex-debug');
    const platformKey = cortexPlatformKey();
    const configuredPath = configuration.get<string>('openocdPath');
    const legacyPath = this.context.globalState.get<string>('openocdPath');
    let firstLimited: ToolProbeResult | undefined;
    let firstFailure: ToolProbeResult | undefined;
    const visited = new Set<string>();
    const groups: Array<() => Promise<ToolCandidate[]>> = [
      async () => this.explicitCandidates([
        [configuredPath || legacyPath, configuredPath ? 'AmphiLink CFG Tool setting' : 'AmphiLink CFG Tool legacy setting']
      ], 1),
      async () => this.explicitCandidates([
        [cortex.get<string>(`openocdPath.${platformKey}`), `Cortex-Debug ${platformKey} openocdPath`]
      ], 2),
      async () => this.explicitCandidates([[cortex.get<string>('openocdPath'), 'Cortex-Debug openocdPath']], 3),
      async () => this.pathCandidates(['openocd'], 4),
      async () => this.openOcdPackageManagerCandidates(executable),
      async () => this.openOcdDefaultCandidates(executable),
      async () => this.openOcdStm32CubeCandidates(executable)
    ];

    for (const group of groups) {
      for (const candidate of await group()) {
        const normalized = normalizeCandidate(candidate.path);
        if (visited.has(normalized) || !(await isExecutable(normalized))) {
          continue;
        }
        visited.add(normalized);
        const result = await this.probeOpenOcdCandidate({ ...candidate, path: normalized });
        if (result.state === 'ready') {
          return result;
        }
        if (result.state === 'limited') {
          firstLimited ??= result;
        } else {
          firstFailure ??= result;
        }
      }
    }

    return firstLimited ?? firstFailure ?? {
      id: 'openocd', label: 'OpenOCD', state: 'missing', details: [],
      capabilities: { wired: false, wireless: false }, error: 'OpenOCD was not found.'
    };
  }

  private async probeOpenOcdCandidate(candidate: ToolCandidate): Promise<ToolProbeResult> {
    const versionResult = await runProcess(candidate.path, ['--version'], { timeoutMs: 5000 });
    const version = firstLine(processOutput(versionResult));
    if (versionResult.code !== 0) {
      return {
        id: 'openocd', label: 'OpenOCD', state: 'error', path: candidate.path,
        source: candidate.source, version, details: [`Search priority: ${candidate.priority}`],
        capabilities: { wired: false, wireless: false },
        error: versionResult.error ?? (processOutput(versionResult) || 'OpenOCD version check failed.')
      };
    }

    const scriptsPath = await this.resolveScriptsPath(candidate.path);
    if (!scriptsPath) {
      return {
        id: 'openocd', label: 'OpenOCD', state: 'incompatible', path: candidate.path,
        source: candidate.source, version,
        details: [`Search priority: ${candidate.priority}`, 'scripts: not found'],
        capabilities: { wired: false, wireless: false },
        error: 'OpenOCD scripts directory was not found.'
      };
    }

    const wiredResult = await runProcess(candidate.path, openOcdUsbProbeArgs(), { timeoutMs: 5000 });
    const wiredOutput = processOutput(wiredResult);
    if (!acceptsOpenOcdUsbProbe(wiredResult.code, wiredOutput)) {
      return {
        id: 'openocd', label: 'OpenOCD', state: 'incompatible', path: candidate.path, scriptsPath,
        source: candidate.source, version,
        details: [`Search priority: ${candidate.priority}`, 'CMSIS-DAP USB bulk backend: unavailable', `scripts: ${scriptsPath}`],
        capabilities: { wired: false, wireless: false },
        error: wiredOutput || 'CMSIS-DAP USB bulk commands were rejected.'
      };
    }

    const capabilityResult = await runProcess(candidate.path, openOcdTcpProbeArgs(), { timeoutMs: 5000 });
    const capabilityOutput = processOutput(capabilityResult);
    const wireless = acceptsOpenOcdTcpProbe(capabilityResult.code, capabilityOutput);
    const details = [
      `Search priority: ${candidate.priority}`,
      'CMSIS-DAP USB bulk backend: supported',
      wireless ? 'CMSIS-DAP TCP backend: supported' : 'CMSIS-DAP TCP backend: unavailable',
      `scripts: ${scriptsPath}`
    ];
    if (!wireless) {
      return {
        id: 'openocd', label: 'OpenOCD', state: 'limited', path: candidate.path, scriptsPath,
        source: candidate.source, version, details, capabilities: { wired: true, wireless: false },
        error: 'Wired mode is available, but wireless mode requires OpenOCD built from the latest master commit with CMSIS-DAP TCP support.'
      };
    }

    return {
      id: 'openocd', label: 'OpenOCD', state: 'ready', path: candidate.path, scriptsPath,
      source: candidate.source, version, details, capabilities: { wired: true, wireless: true }
    };
  }

  private async explicitCandidates(values: Array<[string | undefined, string]>, priority: number): Promise<ToolCandidate[]> {
    const candidates: ToolCandidate[] = [];
    for (const [value, source] of values) {
      if (!value) {
        continue;
      }
      if (isBareExecutableName(value)) {
        candidates.push(...(await findAllOnPath(value)).map((filePath) => ({ path: filePath, source, priority })));
      } else {
        candidates.push({ path: value, source, priority });
      }
    }
    return candidates;
  }

  private async pathCandidates(names: string[], priority: number): Promise<ToolCandidate[]> {
    const candidates: ToolCandidate[] = [];
    for (const name of names) {
      candidates.push(...(await findAllOnPath(name)).map((filePath) => ({ path: filePath, source: 'PATH', priority })));
    }
    return candidates;
  }

  private async gdbPackageManagerCandidates(executable: string): Promise<ToolCandidate[]> {
    const home = os.homedir();
    if (process.platform === 'win32') {
      const programFiles = process.env.ProgramW6432 ?? process.env.ProgramFiles ?? 'C:\\Program Files';
      const roots = [
        path.join(programFiles, 'Arm GNU Toolchain arm-none-eabi'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Arm GNU Toolchain arm-none-eabi'),
        path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Arm GNU Toolchain arm-none-eabi'),
        path.join(process.env.LOCALAPPDATA ?? home, 'Programs', 'Arm GNU Toolchain arm-none-eabi'),
        path.join(home, 'scoop', 'apps', 'gcc-arm-none-eabi'),
        path.join(process.env.APPDATA ?? home, 'xPacks'),
        path.join(process.env.LOCALAPPDATA ?? home, 'xPacks')
      ];
      return this.scannedCandidates(roots, executable, 'Package manager', 5, 6, [
        path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', executable)
      ]);
    }
    const direct = process.platform === 'darwin'
      ? [`/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`, `/opt/local/bin/${executable}`]
      : [`/usr/bin/${executable}`, `/usr/local/bin/${executable}`, `/snap/bin/${executable}`, `/home/linuxbrew/.linuxbrew/bin/${executable}`];
    return this.scannedCandidates([path.join(home, '.local', 'xPacks')], executable, 'Package manager', 5, 6, direct);
  }

  private async gdbDefaultCandidates(executable: string): Promise<ToolCandidate[]> {
    const home = os.homedir();
    const roots = process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA ?? home, 'Arm GNU Toolchain arm-none-eabi'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GNU Arm Embedded Toolchain'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'GNU Arm Embedded Toolchain'),
          'C:\\GNU Arm Embedded Toolchain'
        ]
      : ['/opt/arm-gnu-toolchain', path.join(home, 'arm-gnu-toolchain')];
    return this.scannedCandidates(roots, executable, 'Default installation', 6, 5, [path.join(home, '.local', 'bin', executable)]);
  }

  private async gdbStm32CubeCandidates(executable: string): Promise<ToolCandidate[]> {
    return this.scannedCandidates(stm32CubeRoots(), executable, 'STM32Cube', 7, 9);
  }

  private async openOcdPackageManagerCandidates(executable: string): Promise<ToolCandidate[]> {
    const home = os.homedir();
    if (process.platform === 'win32') {
      return this.scannedCandidates([
        path.join(home, 'scoop', 'apps', 'openocd'),
        path.join(process.env.APPDATA ?? home, 'xPacks'),
        path.join(process.env.LOCALAPPDATA ?? home, 'xPacks'),
        path.join(process.env.LOCALAPPDATA ?? home, 'Programs', 'xPacks')
      ], executable, 'Package manager', 5, 7, [
        path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', executable)
      ]);
    }
    const direct = process.platform === 'darwin'
      ? [`/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`, `/opt/local/bin/${executable}`]
      : [`/usr/bin/${executable}`, `/usr/local/bin/${executable}`, `/snap/bin/${executable}`, `/home/linuxbrew/.linuxbrew/bin/${executable}`];
    return this.scannedCandidates([path.join(home, '.local', 'xPacks')], executable, 'Package manager', 5, 7, direct);
  }

  private async openOcdDefaultCandidates(executable: string): Promise<ToolCandidate[]> {
    const home = os.homedir();
    const roots = process.platform === 'win32'
      ? [
          'C:\\OpenOCD',
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'OpenOCD'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'OpenOCD')
        ]
      : ['/opt/openocd', path.join(home, 'openocd')];
    return this.scannedCandidates(roots, executable, 'Default installation', 6, 5, [path.join(home, '.local', 'bin', executable)]);
  }

  private async openOcdStm32CubeCandidates(executable: string): Promise<ToolCandidate[]> {
    return this.scannedCandidates(stm32CubeRoots(), executable, 'STM32Cube', 7, 9);
  }

  private async scannedCandidates(
    roots: string[], executable: string, source: string, priority: number, maxDepth: number, direct: string[] = []
  ): Promise<ToolCandidate[]> {
    const expected = executable.toLowerCase();
    const found = await Promise.all(roots.map((root) => walkFiles(
      root,
      (filePath) => path.basename(filePath).toLowerCase() === expected,
      { maxDepth, excluded: EXCLUDED_SCAN_DIRECTORIES }
    )));
    const paths = [...direct, ...found.flat().sort(numericDescending)];
    return paths.map((filePath) => ({ path: filePath, source, priority }));
  }

  private async resolveScriptsPath(executable: string): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration('amphilinkCfg').get<string>('openocdScriptsPath');
    const bin = path.dirname(executable);
    const prefix = path.dirname(bin);
    const candidates = [
      configured,
      path.join(prefix, 'share', 'openocd', 'scripts'),
      path.join(prefix, 'openocd', 'scripts'),
      path.join(prefix, 'scripts'),
      process.platform === 'darwin' ? '/opt/homebrew/share/openocd/scripts' : undefined,
      process.platform === 'darwin' ? '/usr/local/share/openocd/scripts' : undefined,
      process.platform === 'darwin' ? '/opt/local/share/openocd/scripts' : undefined,
      process.platform === 'linux' ? '/usr/share/openocd/scripts' : undefined,
      process.platform === 'linux' ? '/usr/local/share/openocd/scripts' : undefined
    ];
    for (const candidate of candidates) {
      if (candidate && (await isDirectory(path.join(expandHome(candidate), 'target')))) {
        return path.resolve(expandHome(candidate));
      }
    }
    return undefined;
  }
}

function stm32CubeRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'stm32cube', 'bundles'),
      '/Applications/STM32CubeIDE.app/Contents/Eclipse/plugins',
      path.join(home, 'Applications', 'STM32CubeIDE.app', 'Contents', 'Eclipse', 'plugins')
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA ?? home, 'stm32cube', 'bundles'),
      path.join(home, 'STM32Cube', 'bundles'),
      'C:\\ST',
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'STMicroelectronics')
    ];
  }
  return [
    path.join(home, '.local', 'share', 'stm32cube', 'bundles'),
    path.join(home, '.stm32cube', 'bundles'),
    '/opt/st',
    path.join(home, 'STMicroelectronics')
  ];
}

function toolchainExecutable(directory: string | undefined, executable: string): string | undefined {
  return directory ? path.join(directory, executable) : undefined;
}

function normalizeCandidate(value: string): string {
  return path.resolve(expandHome(value));
}

function isBareExecutableName(value: string): boolean {
  return !path.isAbsolute(value) && !value.includes('/') && !value.includes('\\');
}

function platformExecutable(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function cortexPlatformKey(): 'windows' | 'osx' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function numericDescending(left: string, right: string): number {
  return right.localeCompare(left, undefined, { numeric: true });
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

export async function listTargetConfigs(scriptsPath: string): Promise<string[]> {
  const targetDirectory = path.join(scriptsPath, 'target');
  if (!(await isDirectory(targetDirectory))) {
    return [];
  }
  return (await readdir(targetDirectory))
    .filter((name) => name.endsWith('.cfg'))
    .sort()
    .map((name) => `target/${name}`);
}
