import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isFile } from '../core/paths';
import { canConnect, DiscoveryService } from '../devices/discoveryService';
import { EnvironmentService, initialEnvironmentStatus } from '../environment/environmentService';
import { InstallService } from '../environment/installService';
import { saveProjectConfiguration } from '../projects/configWriter';
import { ProjectDetector } from '../projects/projectDetector';
import type { DetectedDevice, DeviceScanStatus, ExtensionState, ProjectProfile, SelectableDevice, WebviewMessage } from '../types';

const INITIAL_SCAN: DeviceScanStatus = { scanning: false, phase: 'idle', devices: [], errors: [] };

export class AmphiLinkCfgViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'amphilinkCfg.sidebar';

  private view?: vscode.WebviewView;
  private readonly environmentService: EnvironmentService;
  private readonly installService: InstallService;
  private readonly discoveryService = new DiscoveryService();
  private readonly projectDetector = new ProjectDetector();
  private selectedWorkspace?: vscode.WorkspaceFolder;
  private state: ExtensionState;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.environmentService = new EnvironmentService(context);
    this.installService = new InstallService(() => this.state.locale, () => void this.refreshEnvironment());
    this.state = {
      locale: vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      workspaceCount: vscode.workspace.workspaceFolders?.length ?? 0,
      adapterSpeed: normalizeAdapterSpeed(vscode.workspace.getConfiguration('amphilinkCfg').get<number>('adapterSpeed')),
      environment: initialEnvironmentStatus(),
      scan: structuredClone(INITIAL_SCAN)
    };
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      this.state.workspaceCount = folders.length;
      if (this.selectedWorkspace && !folders.some((folder) => folder.uri.toString() === this.selectedWorkspace?.uri.toString())) {
        this.selectedWorkspace = undefined;
      }
      void this.refreshProject(folders.length > 1 && !this.selectedWorkspace);
    }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message), undefined, this.context.subscriptions);
    view.onDidDispose(() => {
      this.view = undefined;
      this.discoveryService.cancel();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.discoveryService.cancel();
  }

  async refreshEnvironment(): Promise<void> {
    if (this.disposed || this.state.environment.checking) {
      return;
    }
    this.state.environment = await this.environmentService.check((environment) => {
      this.state.environment = environment;
      this.postState();
    });
    await this.refreshProject(!this.selectedWorkspace && (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  }

  async refreshDevices(): Promise<void> {
    const openocd = this.state.environment.openocd;
    if (!openocd.capabilities?.wired || !openocd.path) {
      await vscode.window.showErrorMessage(localized(this.state.locale, 'OpenOCD environment is incomplete.', 'OpenOCD 环境不完整。'));
      return;
    }
    this.state.selectedDevice = undefined;
    this.state.scan = await this.discoveryService.scan(openocd.path, (scan) => {
      this.state.scan = scan;
      this.postState();
    });
  }

  async saveProject(): Promise<void> {
    if (!this.state.environment.complete) {
      await vscode.window.showErrorMessage(localized(this.state.locale, 'Complete the environment check first.', '请先完成环境检查。'));
      return;
    }
    if (!this.state.project || !this.state.selectedDevice) {
      await vscode.window.showErrorMessage(localized(this.state.locale, 'Select a project and an AmphiLink device first.', '请先选择工程和 AmphiLink 设备。'));
      return;
    }
    if (this.state.selectedDevice.kind === 'wireless' && !this.state.environment.openocd.capabilities?.wireless) {
      await vscode.window.showWarningMessage(localized(
        this.state.locale,
        'Wireless mode is unavailable. Build the latest OpenOCD master commit with CMSIS-DAP TCP support first.',
        '无线模式不可用，请先构建支持 CMSIS-DAP TCP 的 OpenOCD master 最新提交。'
      ));
      return;
    }
    if (this.state.project.elfSelectionRequired) {
      await this.chooseElf();
      if (this.state.project?.elfSelectionRequired) {
        return;
      }
    }
    if (this.state.project.targetSelectionRequired) {
      await this.chooseTarget();
      if (this.state.project?.targetSelectionRequired) {
        return;
      }
    }
    if (this.state.selectedDevice.kind === 'wireless'
      && !(await canConnect(this.state.selectedDevice.ip, this.state.selectedDevice.port, 1200))) {
      await vscode.window.showErrorMessage(localized(
        this.state.locale,
        `Cannot reach ${this.state.selectedDevice.ip}:4441.`,
        `无法连接 ${this.state.selectedDevice.ip}:4441。`
      ));
      return;
    }
    try {
      const result = await saveProjectConfiguration({
        project: this.state.project,
        device: this.state.selectedDevice,
        gdb: this.state.environment.gdb,
        openocd: this.state.environment.openocd,
        adapterSpeed: this.state.adapterSpeed
      }, async (existingPath) => {
        const answer = await vscode.window.showWarningMessage(
          localized(
            this.state.locale,
            `${existingPath} is not managed by AmphiLink CFG Tool. Back it up and replace it?`,
            `${existingPath} 不是由 AmphiLink CFG Tool 管理的文件。是否备份并替换？`
          ),
          { modal: true },
          localized(this.state.locale, 'Back up and replace', '备份并替换')
        );
        return Boolean(answer);
      });
      const message = localized(
        this.state.locale,
        `Saved ${path.basename(result.launchPath)} and ${path.basename(result.configPath)}.`,
        `已保存 ${path.basename(result.launchPath)} 和 ${path.basename(result.configPath)}。`
      );
      await vscode.window.showInformationMessage(message);
    } catch (error) {
      await vscode.window.showErrorMessage(localizedError(this.state.locale, error));
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        await this.refreshEnvironment();
        break;
      case 'refreshEnvironment':
        await this.refreshEnvironment();
        break;
      case 'refreshDevices':
        await this.refreshDevices();
        break;
      case 'selectDevice':
        await this.selectDevice(message.key);
        break;
      case 'openDevicePage':
        await this.openDevicePage(Boolean(message.hotspot));
        break;
      case 'saveProject':
        await this.saveProject();
        break;
      case 'chooseToolPath':
        await this.chooseToolPath(message.tool);
        break;
      case 'installTool':
        await this.installService.install(
          message.tool,
          message.tool === 'openocd' && this.state.environment.openocd.state === 'limited'
        );
        break;
      case 'chooseElf':
        await this.chooseElf();
        break;
      case 'chooseTarget':
        await this.chooseTarget();
        break;
      case 'chooseWorkspace':
        await this.refreshProject(true);
        break;
      case 'setAdapterSpeed':
        await this.setAdapterSpeed(message.value);
        break;
      case 'setProjectField':
        await this.setProjectField(message.field, message.value);
        break;
    }
  }

  private async selectDevice(key: string): Promise<void> {
    const device = this.state.scan.devices.find((candidate) => candidate.key === key);
    if (!device || device.kind === 'hotspot') {
      return;
    }
    if (device.kind === 'wireless' && !(await canConnect(device.ip, device.port, 1200))) {
      device.reachable = false;
      this.postState();
      await vscode.window.showErrorMessage(localized(
        this.state.locale,
        `Cannot reach ${device.ip}:4441.`,
        `无法连接 ${device.ip}:4441。`
      ));
      return;
    }
    if (device.kind === 'wireless') {
      device.reachable = true;
    }
    this.state.selectedDevice = device;
    this.postState();
  }

  private async openDevicePage(hotspot: boolean): Promise<void> {
    let url: string | undefined;
    if (hotspot) {
      url = 'http://192.168.4.1/';
    } else if (this.state.selectedDevice?.kind === 'wireless') {
      url = `http://${this.state.selectedDevice.ip}/`;
    }
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async chooseToolPath(tool: 'gdb' | 'openocd' | 'scripts'): Promise<void> {
    const directory = tool === 'scripts';
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: !directory,
      canSelectFolders: directory,
      canSelectMany: false,
      title: localized(this.state.locale, `Select ${tool} path`, `选择 ${tool} 路径`),
      filters: directory ? undefined : { Executable: process.platform === 'win32' ? ['exe'] : ['*'] }
    });
    const selected = selection?.[0]?.fsPath;
    if (!selected) {
      return;
    }
    const key = tool === 'scripts' ? 'openocdScriptsPath' : `${tool}Path`;
    await vscode.workspace.getConfiguration('amphilinkCfg').update(key, selected, vscode.ConfigurationTarget.Global);
    if (tool === 'openocd') {
      await this.context.globalState.update('openocdPath', selected);
    }
    await this.refreshEnvironment();
  }

  private async refreshProject(promptForWorkspace: boolean): Promise<void> {
    const workspace = await this.workspaceFolder(promptForWorkspace);
    if (!workspace) {
      this.state.project = undefined;
      this.postState();
      return;
    }
    this.state.project = await this.projectDetector.detect(
      workspace.uri.fsPath,
      this.state.environment.openocd.scriptsPath
    );
    this.postState();
  }

  private async workspaceFolder(prompt: boolean): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return undefined;
    }
    if (folders.length === 1) {
      this.selectedWorkspace = folders[0];
      return folders[0];
    }
    if (!prompt && this.selectedWorkspace) {
      return this.selectedWorkspace;
    }
    if (!prompt) {
      const editorUri = vscode.window.activeTextEditor?.document.uri;
      const activeFolder = editorUri && vscode.workspace.getWorkspaceFolder(editorUri);
      if (activeFolder) {
        this.selectedWorkspace = activeFolder;
        return activeFolder;
      }
    }
    const selected = await vscode.window.showWorkspaceFolderPick({
      placeHolder: localized(this.state.locale, 'Select the project folder', '选择工程文件夹')
    });
    if (selected) {
      this.selectedWorkspace = selected;
    }
    return selected ?? this.selectedWorkspace;
  }

  private async chooseElf(): Promise<void> {
    const project = this.state.project;
    if (!project) {
      return;
    }
    const browseLabel = localized(this.state.locale, 'Browse for another ELF...', '浏览其它 ELF...');
    const chosen = project.elfCandidates.length
      ? await vscode.window.showQuickPick([
          ...project.elfCandidates.map((candidate) => ({
            label: path.basename(candidate),
            description: path.relative(project.workspacePath, candidate) || candidate,
            value: candidate
          })),
          { label: browseLabel, value: '' }
        ], { title: localized(this.state.locale, 'Select the project ELF', '选择工程 ELF'), matchOnDescription: true })
      : { value: '' };
    if (!chosen) {
      return;
    }
    if (chosen.value) {
      await this.setProjectField('elfPath', chosen.value);
      return;
    }
    const selection = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(project.workspacePath),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'ELF executable': ['elf'] }
    });
    if (selection?.[0]) {
      await this.setProjectField('elfPath', selection[0].fsPath);
    }
  }

  private async chooseTarget(): Promise<void> {
    const project = this.state.project;
    if (!project) {
      return;
    }
    const browseLabel = localized(this.state.locale, 'Browse for another config...', '浏览其它配置...');
    const chosen = await vscode.window.showQuickPick([
      ...project.targetCandidates.map((candidate) => ({ label: candidate, value: candidate })),
      { label: browseLabel, value: '' }
    ], {
      title: localized(this.state.locale, 'OpenOCD target config', 'OpenOCD 目标配置'),
      matchOnDescription: true
    });
    if (!chosen) {
      return;
    }
    if (chosen.value) {
      await this.setProjectField('targetConfig', chosen.value);
      return;
    }
    const selection = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.file(project.workspacePath),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'OpenOCD config': ['cfg'] }
    });
    if (selection?.[0]) {
      await this.setProjectField('targetConfig', selection[0].fsPath);
    }
  }

  private async setProjectField(field: 'elfPath' | 'targetConfig', value: string): Promise<void> {
    const project = this.state.project;
    if (!project) {
      return;
    }
    const updated: ProjectProfile = { ...project };
    const trimmed = value.trim();
    if (field === 'elfPath') {
      const resolved = trimmed && !path.isAbsolute(trimmed) ? path.resolve(project.workspacePath, trimmed) : trimmed;
      updated.elfPath = resolved || undefined;
      updated.elfExists = await isFile(resolved);
      updated.elfSelectionRequired = false;
      updated.elfCandidates = resolved
        ? [resolved, ...updated.elfCandidates.filter((candidate) => candidate !== resolved)]
        : updated.elfCandidates;
    } else {
      updated.targetConfig = trimmed || undefined;
      const targetPath = trimmed.startsWith('target/') && this.state.environment.openocd.scriptsPath
        ? path.join(this.state.environment.openocd.scriptsPath, trimmed)
        : path.isAbsolute(trimmed) ? trimmed : path.join(project.workspacePath, trimmed);
      updated.targetConfigExists = await isFile(targetPath);
      updated.targetSelectionRequired = false;
      updated.targetCandidates = trimmed
        ? [trimmed, ...updated.targetCandidates.filter((candidate) => candidate !== trimmed)]
        : updated.targetCandidates;
    }
    updated.source = 'manual';
    this.state.project = updated;
    this.postState();
  }

  private async setAdapterSpeed(value: number): Promise<void> {
    const normalized = normalizeAdapterSpeed(value);
    this.state.adapterSpeed = normalized;
    await vscode.workspace.getConfiguration('amphilinkCfg').update(
      'adapterSpeed', normalized, vscode.ConfigurationTarget.Workspace
    );
    this.postState();
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    return `<!doctype html>
<html lang="${this.state.locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>AmphiLink CFG Tool</title>
</head>
<body>
  <header class="brand"><span class="brand-logo" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m12.25 19.75-2.75 2.75a4 4 0 0 1-5.66-5.66l4.25-4.25a4 4 0 0 1 5.66 0"/><path d="m19.75 12.25 2.75-2.75a4 4 0 0 1 5.66 5.66l-4.25 4.25a4 4 0 0 1-5.66 0"/><path d="m11 21 10-10"/><path d="M7 5.25v3.5M5.25 7h3.5M25 23.25v3.5M23.25 25h3.5"/></svg></span><strong>AmphiLink CFG Tool</strong></header>
  <nav class="segments" aria-label="Views">
    <button id="tab-environment" class="active" data-tab="environment"></button>
    <button id="tab-devices" data-tab="devices"></button>
  </nav>
  <main>
    <section id="panel-environment" class="panel"></section>
    <section id="panel-devices" class="panel" hidden></section>
    <section id="configuration" class="configuration"></section>
  </main>
  <div id="toast" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function localized(locale: ExtensionState['locale'], english: string, chinese: string): string {
  return locale === 'zh-cn' ? chinese : english;
}

function localizedError(locale: ExtensionState['locale'], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (locale !== 'zh-cn') {
    return message;
  }
  const translations: Array<[RegExp, string]> = [
    [/^Cortex-Debug environment is incomplete\.$/, 'Cortex-Debug 环境不完整。'],
    [/^Wireless mode requires OpenOCD built from the latest master commit with CMSIS-DAP TCP support\.$/, '无线模式需要构建支持 CMSIS-DAP TCP 的 OpenOCD master 最新提交。'],
    [/^The selected ELF file does not exist\. Build the project first\.$/, '所选 ELF 文件不存在，请先构建工程。'],
    [/^The selected OpenOCD target config does not exist\.$/, '所选 OpenOCD target config 不存在。'],
    [/^Existing \.vscode\/launch\.json contains invalid JSONC\.$/, '现有 .vscode/launch.json 包含无效 JSONC。'],
    [/^Configuration save was cancelled\.$/, '已取消保存配置。']
  ];
  return translations.find(([pattern]) => pattern.test(message))?.[1] ?? message;
}

function normalizeAdapterSpeed(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 1 && value! <= 50000 ? value! : 1000;
}

export function isSelectableDevice(device: DetectedDevice): device is SelectableDevice {
  return device.kind === 'wired' || device.kind === 'wireless';
}
