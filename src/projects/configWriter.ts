import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { applyEdits, modify, parse as parseJsonc, type FormattingOptions } from 'jsonc-parser';
import { AMPHILINK_USB_DEVICE, type ProjectProfile, type SelectableDevice, type ToolProbeResult } from '../types';

const MANAGED_MARKER = '# Managed by the AmphiLink CFG Tool VS Code extension.';
const CONFIG_RELATIVE_PATH = '.vscode/amphilink-cfg-openocd.cfg';

export interface SaveProjectInput {
  project: ProjectProfile;
  device: SelectableDevice;
  gdb: ToolProbeResult;
  openocd: ToolProbeResult;
  adapterSpeed: number;
}

export interface SaveProjectResult {
  launchPath: string;
  configPath: string;
  backupPath?: string;
}

export function generateOpenOcdConfig(device: SelectableDevice, targetConfig: string, adapterSpeed = 1000): string {
  if (/[\r\n]/.test(targetConfig)) {
    throw new Error('The OpenOCD target config path contains an invalid line break.');
  }
  if (!Number.isInteger(adapterSpeed) || adapterSpeed < 1 || adapterSpeed > 50000) {
    throw new Error('The OpenOCD adapter speed must be an integer from 1 to 50000 kHz.');
  }
  const safeDeviceName = [...device.name].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  const lines = [MANAGED_MARKER, `# Device: ${safeDeviceName}`];
  if (device.kind === 'wireless') {
    lines.push(
      'adapter driver cmsis-dap',
      'cmsis-dap backend tcp',
      `cmsis-dap tcp host ${device.ip}`,
      'cmsis-dap tcp port 4441',
      'cmsis-dap tcp min_timeout 300'
    );
  } else {
    lines.push(
      'adapter driver cmsis-dap',
      'cmsis-dap backend usb_bulk',
      `cmsis_dap_vid_pid 0x${AMPHILINK_USB_DEVICE.vid} 0x${AMPHILINK_USB_DEVICE.pid}`
    );
  }
  const sourcePath = /\s/.test(targetConfig) ? `{${targetConfig.replaceAll('}', '\\}')}}` : targetConfig;
  lines.push('transport select swd', '', `source [find ${sourcePath}]`, `adapter speed ${adapterSpeed}`, '');
  return lines.join('\n');
}

export function launchEntry(input: SaveProjectInput): Record<string, unknown> {
  const { project, gdb, openocd } = input;
  const entry: Record<string, unknown> = {
    name: `AmphiLink CFG: ${project.mcu ?? project.projectName ?? project.workspaceName}`,
    type: 'cortex-debug',
    request: 'launch',
    cwd: '${workspaceFolder}',
    executable: toWorkspaceVariable(project.workspacePath, project.elfPath!),
    servertype: 'openocd',
    serverpath: openocd.path,
    gdbPath: gdb.path,
    searchDir: [openocd.scriptsPath],
    configFiles: [`\${workspaceFolder}/${CONFIG_RELATIVE_PATH}`],
    runToEntryPoint: 'main',
    showDevDebugOutput: 'none'
  };
  if (project.svdPath) {
    entry.svdFile = toWorkspaceVariable(project.workspacePath, project.svdPath);
  }
  return entry;
}

export async function saveProjectConfiguration(
  input: SaveProjectInput,
  confirmReplace: (existingPath: string) => Promise<boolean>
): Promise<SaveProjectResult> {
  validateSaveInput(input);
  const vscodeDirectory = path.join(input.project.workspacePath, '.vscode');
  const configPath = path.join(vscodeDirectory, 'amphilink-cfg-openocd.cfg');
  const launchPath = path.join(vscodeDirectory, 'launch.json');
  await mkdir(vscodeDirectory, { recursive: true });

  let backupPath: string | undefined;
  try {
    const currentConfig = await readFile(configPath, 'utf8');
    if (!currentConfig.startsWith(MANAGED_MARKER)) {
      if (!(await confirmReplace(configPath))) {
        throw new Error('Configuration save was cancelled.');
      }
      backupPath = `${configPath}.bak`;
      await copyFile(configPath, backupPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof Error && error.message.includes('cancelled'))) {
      throw error;
    }
    if (error instanceof Error && error.message.includes('cancelled')) {
      throw error;
    }
  }

  await atomicWrite(configPath, generateOpenOcdConfig(input.device, input.project.targetConfig!, input.adapterSpeed));
  const launchText = await readExistingOrDefault(launchPath);
  const updated = mergeLaunchConfiguration(launchText, launchEntry(input));
  await atomicWrite(launchPath, updated);
  return { launchPath, configPath, backupPath };
}

export function mergeLaunchConfiguration(text: string, entry: Record<string, unknown>): string {
  const errors: import('jsonc-parser').ParseError[] = [];
  const document = parseJsonc(text, errors) as Record<string, any>;
  if (errors.length) {
    throw new Error('Existing .vscode/launch.json contains invalid JSONC.');
  }
  const configurations = Array.isArray(document?.configurations) ? document.configurations : [];
  const managedIndex = configurations.findIndex((configuration: any) =>
    Array.isArray(configuration?.configFiles)
      && configuration.configFiles.some((file: unknown) => typeof file === 'string' && file.endsWith('/.vscode/amphilink-cfg-openocd.cfg'))
  );
  const formatting: FormattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };
  let result = text;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    result = '{\n    "version": "0.2.0",\n    "configurations": []\n}\n';
  } else if (!Array.isArray(document.configurations)) {
    result = applyEdits(result, modify(result, ['configurations'], [], { formattingOptions: formatting }));
  }
  const targetIndex = managedIndex >= 0 ? managedIndex : configurations.length;
  result = applyEdits(result, modify(result, ['configurations', targetIndex], entry, {
    formattingOptions: formatting,
    isArrayInsertion: managedIndex < 0
  }));
  return result.endsWith('\n') ? result : `${result}\n`;
}

function validateSaveInput(input: SaveProjectInput): void {
  if (input.gdb.state !== 'ready' || !input.openocd.capabilities?.wired) {
    throw new Error('Cortex-Debug environment is incomplete.');
  }
  if (input.device.kind === 'wireless' && !input.openocd.capabilities.wireless) {
    throw new Error('Wireless mode requires OpenOCD built from the latest master commit with CMSIS-DAP TCP support.');
  }
  if (!input.project.elfPath || !input.project.elfExists) {
    throw new Error('The selected ELF file does not exist. Build the project first.');
  }
  if (!input.project.targetConfig || !input.project.targetConfigExists) {
    throw new Error('The selected OpenOCD target config does not exist.');
  }
}

function toWorkspaceVariable(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return relative.startsWith('..') ? filePath : `\${workspaceFolder}/${relative}`;
}

async function readExistingOrDefault(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '{\n    "version": "0.2.0",\n    "configurations": []\n}\n';
    }
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.amphilink-cfg.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}
