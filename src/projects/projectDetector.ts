import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { isFile, walkFiles } from '../core/paths';
import type { ProjectProfile, ProjectSource } from '../types';
import { stm32TargetFor } from './stm32Targets';

interface Candidate {
  source: ProjectSource;
  confidence: number;
  projectName?: string;
  mcu?: string;
  family?: string;
  buildType?: string;
  elfPath?: string;
  targetConfig?: string;
}

export class ProjectDetector {
  async detect(workspacePath: string, scriptsPath?: string): Promise<ProjectProfile> {
    const candidates = [
      await this.detectCubeMx(workspacePath),
      await this.detectExistingLaunch(workspacePath),
      await this.detectCmakeFileApi(workspacePath),
      await this.detectGenericCmake(workspacePath),
      await this.detectPlatformIo(workspacePath)
    ].filter((value): value is Candidate => Boolean(value));
    const hasStructuredElf = candidates.some((candidate) => Boolean(candidate.elfPath));

    const elfCandidates = await this.scanElfs(workspacePath);
    if (elfCandidates[0]) {
      candidates.push({ source: 'elf-scan', confidence: 40, elfPath: elfCandidates[0] });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = this.mergeCandidates(candidates);
    const targetCandidates = await this.targetCandidates(scriptsPath, best.targetConfig);
    const targetConfig = best.targetConfig;
    const elfPath = best.elfPath ?? elfCandidates[0];
    const svdPath = await this.findSvd(workspacePath, best.mcu);
    const warnings: string[] = [];
    const elfExists = await isFile(elfPath);
    const targetConfigExists = targetConfig
      ? await this.targetExists(targetConfig, workspacePath, scriptsPath)
      : false;
    if (elfPath && !elfExists) {
      warnings.push(`ELF has not been built: ${elfPath}`);
    }
    if (targetConfig && !targetConfigExists) {
      warnings.push(`OpenOCD target config was not found: ${targetConfig}`);
    }
    if (!targetConfig) {
      warnings.push('Unable to determine the OpenOCD target config.');
    }

    return {
      workspacePath,
      workspaceName: path.basename(workspacePath),
      source: best.source ?? 'none',
      confidence: best.confidence ?? 0,
      projectName: best.projectName,
      mcu: best.mcu,
      family: best.family,
      buildType: best.buildType,
      elfPath,
      elfExists,
      elfCandidates: unique([elfPath, ...elfCandidates]),
      elfSelectionRequired: !hasStructuredElf && elfCandidates.length > 1,
      targetConfig,
      targetConfigExists,
      targetCandidates,
      targetSelectionRequired: !best.targetConfig && targetCandidates.length > 0,
      svdPath,
      warnings
    };
  }

  private async detectCubeMx(root: string): Promise<Candidate | undefined> {
    const ioc = (await readdir(root)).find((name) => name.endsWith('.ioc'));
    if (!ioc) {
      return undefined;
    }
    const content = await readFile(path.join(root, ioc), 'utf8');
    const values = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator > 0) {
        values.set(line.slice(0, separator), line.slice(separator + 1));
      }
    }
    if (values.get('ProjectManager.TargetToolchain') !== 'CMake' && !(await isFile(path.join(root, 'CMakeLists.txt')))) {
      return undefined;
    }
    const projectName = values.get('ProjectManager.ProjectName') ?? path.basename(ioc, '.ioc');
    const mcu = values.get('Mcu.CPN') ?? values.get('ProjectManager.DeviceId') ?? values.get('Mcu.Name');
    const family = values.get('Mcu.Family');
    const preset = await this.debugPreset(root);
    const binaryDirectory = preset?.binaryDir ?? path.join(root, 'build', 'Debug');
    return {
      source: 'cubemx-cmake', confidence: 100, projectName, mcu, family,
      buildType: preset?.name ?? 'Debug',
      elfPath: path.join(binaryDirectory, `${projectName}.elf`),
      targetConfig: stm32TargetFor(mcu) ?? stm32TargetFor(family)
    };
  }

  private async debugPreset(root: string): Promise<{ name: string; binaryDir: string } | undefined> {
    const filePath = path.join(root, 'CMakePresets.json');
    if (!(await isFile(filePath))) {
      return undefined;
    }
    const document = parseJsonc(await readFile(filePath, 'utf8')) as Record<string, any>;
    const presets = Array.isArray(document.configurePresets) ? document.configurePresets : [];
    const debug = presets.find((item: any) => item.name === 'Debug') ?? presets.find((item: any) => !item.hidden);
    const inherited = debug?.inherits
      ? presets.find((item: any) => item.name === debug.inherits || (Array.isArray(debug.inherits) && debug.inherits.includes(item.name)))
      : undefined;
    const raw = debug?.binaryDir ?? inherited?.binaryDir;
    if (!raw) {
      return undefined;
    }
    return {
      name: String(debug.name),
      binaryDir: path.resolve(root, String(raw)
        .replaceAll('${sourceDir}', root)
        .replaceAll('${sourceParentDir}', path.dirname(root))
        .replaceAll('${sourceDirName}', path.basename(root))
        .replaceAll('${presetName}', String(debug.name)))
    };
  }

  private async detectExistingLaunch(root: string): Promise<Candidate | undefined> {
    const launchPath = path.join(root, '.vscode', 'launch.json');
    if (!(await isFile(launchPath))) {
      return undefined;
    }
    const document = parseJsonc(await readFile(launchPath, 'utf8')) as Record<string, any>;
    const configurations = Array.isArray(document.configurations) ? document.configurations : [];
    const configuration = configurations.find((item: any) => item.type === 'cortex-debug' && item.servertype === 'openocd');
    if (!configuration) {
      return undefined;
    }
    const elfPath = typeof configuration.executable === 'string'
      ? resolveWorkspaceValue(root, configuration.executable)
      : undefined;
    let targetConfig: string | undefined;
    const configFile = configuration.configFiles?.find((item: unknown) => typeof item === 'string');
    if (typeof configFile === 'string') {
      const resolved = resolveWorkspaceValue(root, configFile);
      if (await isFile(resolved)) {
        targetConfig = extractTargetConfig(await readFile(resolved, 'utf8'));
      }
    }
    return { source: 'existing-launch', confidence: 90, elfPath, targetConfig };
  }

  private async detectCmakeFileApi(root: string): Promise<Candidate | undefined> {
    const replies = await walkFiles(root, (file) => /[\\/]\.cmake[\\/]api[\\/]v1[\\/]reply[\\/]target-.+\.json$/.test(file), {
      maxDepth: 7,
      excluded: new Set(['.git', 'node_modules', 'Drivers', 'Middlewares'])
    });
    for (const reply of replies) {
      try {
        const document = JSON.parse(await readFile(reply, 'utf8')) as Record<string, any>;
        const artifact = document.artifacts?.find((item: any) => typeof item.path === 'string' && item.path.endsWith('.elf'));
        if (artifact) {
          const buildRoot = reply.slice(0, reply.indexOf(`${path.sep}.cmake${path.sep}`));
          return {
            source: 'cmake-file-api', confidence: 80,
            projectName: document.name,
            elfPath: path.resolve(buildRoot, artifact.path)
          };
        }
      } catch {
        // Ignore incomplete CMake File API replies.
      }
    }
    return undefined;
  }

  private async detectGenericCmake(root: string): Promise<Candidate | undefined> {
    const cmakePath = path.join(root, 'CMakeLists.txt');
    if (!(await isFile(cmakePath))) {
      return undefined;
    }
    const content = await readFile(cmakePath, 'utf8');
    const projectName = content.match(/set\s*\(\s*CMAKE_PROJECT_NAME\s+([^\s)]+)/i)?.[1]
      ?? content.match(/project\s*\(\s*([^\s)]+)/i)?.[1];
    if (!projectName || projectName.includes('$')) {
      return { source: 'generic-cmake', confidence: 45 };
    }
    const preset = await this.debugPreset(root);
    return {
      source: 'generic-cmake', confidence: 60, projectName,
      buildType: preset?.name ?? 'Debug',
      elfPath: path.join(preset?.binaryDir ?? path.join(root, 'build', 'Debug'), `${projectName}.elf`)
    };
  }

  private async detectPlatformIo(root: string): Promise<Candidate | undefined> {
    const iniPath = path.join(root, 'platformio.ini');
    if (!(await isFile(iniPath))) {
      return undefined;
    }
    const content = await readFile(iniPath, 'utf8');
    const environment = content.match(/^\[env:([^\]]+)]/m)?.[1];
    if (!environment) {
      return { source: 'platformio', confidence: 45 };
    }
    return {
      source: 'platformio', confidence: 65, projectName: environment,
      elfPath: path.join(root, '.pio', 'build', environment, 'firmware.elf')
    };
  }

  private mergeCandidates(candidates: Candidate[]): Candidate {
    const best = candidates[0] ?? { source: 'none' as const, confidence: 0 };
    return candidates.slice(1).reduce((merged, candidate) => ({
      ...merged,
      projectName: merged.projectName ?? candidate.projectName,
      mcu: merged.mcu ?? candidate.mcu,
      family: merged.family ?? candidate.family,
      buildType: merged.buildType ?? candidate.buildType,
      elfPath: merged.elfPath ?? candidate.elfPath,
      targetConfig: merged.targetConfig ?? candidate.targetConfig
    }), { ...best });
  }

  private async scanElfs(root: string): Promise<string[]> {
    const files = await walkFiles(root, (file) => file.endsWith('.elf'), {
      maxDepth: 6,
      excluded: new Set(['.git', 'node_modules', 'Drivers', 'Middlewares'])
    });
    const withStats = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(file)).mtimeMs })));
    return withStats
      .sort((a, b) => scoreElf(b.file, b.modified) - scoreElf(a.file, a.modified))
      .map((item) => item.file);
  }

  private async targetCandidates(scriptsPath: string | undefined, preferred?: string): Promise<string[]> {
    if (!scriptsPath) {
      return preferred ? [preferred] : [];
    }
    let names: string[] = [];
    try {
      names = (await readdir(path.join(scriptsPath, 'target')))
        .filter((name) => name.endsWith('.cfg'))
        .sort()
        .map((name) => `target/${name}`);
    } catch {
      return preferred ? [preferred] : [];
    }
    return unique([preferred, ...names]);
  }

  private async targetExists(config: string, root: string, scriptsPath?: string): Promise<boolean> {
    if (path.isAbsolute(config)) {
      return isFile(config);
    }
    if (config.startsWith('target/') && scriptsPath) {
      return isFile(path.join(scriptsPath, config));
    }
    return isFile(path.join(root, config));
  }

  private async findSvd(root: string, mcu?: string): Promise<string | undefined> {
    const files = await walkFiles(root, (file) => file.toLowerCase().endsWith('.svd'), { maxDepth: 5 });
    if (!files.length) {
      return undefined;
    }
    const prefix = mcu?.slice(0, 10).toLowerCase();
    return files.find((file) => prefix && path.basename(file).toLowerCase().startsWith(prefix)) ?? files[0];
  }
}

export function extractTargetConfig(content: string): string | undefined {
  return content.match(/source\s+\[find\s+(target\/[\w.-]+\.cfg)\]/i)?.[1];
}

function resolveWorkspaceValue(root: string, value: string): string {
  return path.resolve(value.replaceAll('${workspaceFolder}', root).replaceAll('${workspaceRoot}', root));
}

function scoreElf(file: string, modified: number): number {
  const debug = /[\\/]Debug[\\/]/i.test(file) ? 1e15 : 0;
  const firmware = /firmware\.elf$/i.test(file) ? 1e14 : 0;
  return debug + firmware + modified;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
