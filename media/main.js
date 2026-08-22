(function () {
  const vscode = acquireVsCodeApi();
  let state;
  let activeTab = 'environment';

  const strings = {
    'zh-cn': {
      environment: '环境检查', devices: '设备连接', configuration: '配置详细', refresh: '重新检查', scan: '刷新设备',
      install: '安装', path: '路径', ready: '可用', limited: '仅有线可用', missing: '未安装', incompatible: '不兼容', error: '检查失败', checking: '检查中',
      chooseGdb: '选择 GDB 路径', chooseOpenocd: '选择 OpenOCD 路径', chooseScripts: '选择 OpenOCD scripts 路径',
      noDevices: '未发现 AmphiLink', wired: '有线', wireless: '无线', hotspot: '配置热点', unreachable: '端口不可达', colorId: '颜色 ID',
      select: '选择', selected: '已选择', openPage: '打开配置网页', hotspotHint: '请手动连接该热点，然后进入 192.168.4.1 配置。',
      workspace: '工程', detector: '识别方式', mcu: '目标芯片', elf: 'ELF', target: '目标配置', choose: '选择',
      adapterSpeed: '调试速度', kilohertz: 'kHz',
      currentEnvironment: '当前环境', switchProject: '切换工程', confirmElf: '请选择一个 ELF 候选', confirmTarget: '请选择目标配置',
      save: '为当前项目保存', buildFirst: '请先构建工程生成 ELF', environmentIncomplete: '环境不完整', deviceRequired: '请选择有线或无线设备', wirelessOpenocdRequired: '无线模式不可用，请先构建支持 CMSIS-DAP TCP 的 OpenOCD master 最新提交',
      noWorkspace: '当前未打开工程文件夹', scanningWired: '正在检查有线设备', scanningWireless: '正在监听局域网广播', scanningHotspot: '正在扫描 AmphiLink 热点',
      source: { 'cubemx-cmake': 'STM32CubeMX CMake', 'existing-launch': '现有调试配置', 'cmake-file-api': 'CMake File API', 'generic-cmake': 'CMake', platformio: 'PlatformIO', 'elf-scan': 'ELF 扫描', manual: '手动配置', none: '未识别' }
    },
    en: {
      environment: 'Environment', devices: 'Devices', configuration: 'Configuration', refresh: 'Check again', scan: 'Refresh devices',
      install: 'Install', path: 'Path', ready: 'Ready', limited: 'Wired only', missing: 'Missing', incompatible: 'Incompatible', error: 'Check failed', checking: 'Checking',
      chooseGdb: 'Choose GDB path', chooseOpenocd: 'Choose OpenOCD path', chooseScripts: 'Choose OpenOCD scripts path',
      noDevices: 'No AmphiLink found', wired: 'Wired', wireless: 'Wireless', hotspot: 'Setup hotspot', unreachable: 'Port unreachable', colorId: 'Color ID',
      select: 'Select', selected: 'Selected', openPage: 'Open configuration page', hotspotHint: 'Connect to this hotspot manually, then open 192.168.4.1.',
      workspace: 'Project', detector: 'Detected by', mcu: 'Target MCU', elf: 'ELF', target: 'Target config', choose: 'Choose',
      adapterSpeed: 'Adapter speed', kilohertz: 'kHz',
      currentEnvironment: 'Current environment', switchProject: 'Switch project', confirmElf: 'Select an ELF candidate', confirmTarget: 'Select a target config',
      save: 'Save for current project', buildFirst: 'Build the project to create the ELF first', environmentIncomplete: 'Environment is incomplete', deviceRequired: 'Select a wired or wireless device', wirelessOpenocdRequired: 'Wireless mode is unavailable. Build the latest OpenOCD master commit with CMSIS-DAP TCP support.',
      noWorkspace: 'No project folder is open', scanningWired: 'Checking wired devices', scanningWireless: 'Listening for LAN broadcasts', scanningHotspot: 'Scanning for AmphiLink hotspots',
      source: { 'cubemx-cmake': 'STM32CubeMX CMake', 'existing-launch': 'Existing debug config', 'cmake-file-api': 'CMake File API', 'generic-cmake': 'CMake', platformio: 'PlatformIO', 'elf-scan': 'ELF scan', manual: 'Manual', none: 'Not detected' }
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  const t = (key) => strings[state?.locale || 'en'][key] ?? key;
  const icon = (name) => `<i class="codicon codicon-${name}" aria-hidden="true"></i>`;

  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    renderTabs();
  }));

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'refresh-environment') vscode.postMessage({ type: 'refreshEnvironment' });
    if (action === 'refresh-devices') vscode.postMessage({ type: 'refreshDevices' });
    if (action === 'install') vscode.postMessage({ type: 'installTool', tool: button.dataset.tool });
    if (action === 'tool-path') vscode.postMessage({ type: 'chooseToolPath', tool: button.dataset.tool });
    if (action === 'select-device') vscode.postMessage({ type: 'selectDevice', key: button.dataset.key });
    if (action === 'open-page') vscode.postMessage({ type: 'openDevicePage' });
    if (action === 'open-hotspot') vscode.postMessage({ type: 'openDevicePage', hotspot: true });
    if (action === 'choose-elf') vscode.postMessage({ type: 'chooseElf' });
    if (action === 'choose-target') vscode.postMessage({ type: 'chooseTarget' });
    if (action === 'choose-workspace') vscode.postMessage({ type: 'chooseWorkspace' });
    if (action === 'save') vscode.postMessage({ type: 'saveProject' });
  });

  document.addEventListener('change', (event) => {
    const input = event.target.closest('[data-project-field]');
    if (input) {
      vscode.postMessage({ type: 'setProjectField', field: input.dataset.projectField, value: input.value });
    }
    const setting = event.target.closest('[data-setting="adapterSpeed"]');
    if (setting) {
      vscode.postMessage({ type: 'setAdapterSpeed', value: Number(setting.value) });
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'state') {
      state = event.data.state;
      render();
    }
  });

  function render() {
    $('#tab-environment').textContent = t('environment');
    $('#tab-devices').textContent = t('devices');
    renderTabs();
    renderEnvironment();
    renderDevices();
    renderConfiguration();
  }

  function renderTabs() {
    $('#tab-environment').classList.toggle('active', activeTab === 'environment');
    $('#tab-devices').classList.toggle('active', activeTab === 'devices');
    $('#panel-environment').hidden = activeTab !== 'environment';
    $('#panel-devices').hidden = activeTab !== 'devices';
  }

  function stateLabel(probe) {
    return probe.state === 'checking' ? t('checking') : probe.state === 'ready' ? t('ready') : probe.state === 'limited' ? t('limited') : probe.state === 'missing' ? t('missing') : probe.state === 'incompatible' ? t('incompatible') : t('error');
  }

  function renderEnvironment() {
    const probes = [state.environment.cortex, state.environment.gdb, state.environment.openocd];
    $('#panel-environment').innerHTML = `
      <div class="section-toolbar"><h2>${t('environment')}</h2><button class="icon-command" data-action="refresh-environment" title="${t('refresh')}" ${state.environment.checking ? 'disabled' : ''}>${icon('refresh')}<span>${t('refresh')}</span></button></div>
      <div class="tool-list">${probes.map((probe) => `
        <div class="tool-row">
          <span class="tool-state ${probe.state}">${icon(probe.state === 'ready' ? 'pass-filled' : probe.state === 'checking' ? 'loading' : probe.state === 'limited' ? 'warning' : 'error')}</span>
          <div class="tool-main"><strong>${escapeHtml(probe.label)}</strong><span>${escapeHtml(probe.version || stateLabel(probe))}</span>${probe.path ? `<code title="${escapeHtml(probe.path)}">${escapeHtml(probe.path)}</code>` : ''}${probe.error ? `<span class="error-text">${escapeHtml(runtimeText(probe.error))}</span>` : ''}</div>
          <div class="row-actions">${probe.state !== 'ready' ? `<button class="icon-only" data-action="install" data-tool="${probe.id}" title="${t('install')}">${icon('cloud-download')}</button>` : ''}${probe.id !== 'cortex' ? `<button class="icon-only" data-action="tool-path" data-tool="${probe.id}" title="${probe.id === 'gdb' ? t('chooseGdb') : t('chooseOpenocd')}">${icon('folder-opened')}</button>` : ''}${probe.id === 'openocd' ? `<button class="icon-only" data-action="tool-path" data-tool="scripts" title="${t('chooseScripts')}">${icon('library')}</button>` : ''}</div>
        </div>`).join('')}</div>`;
  }

  function renderDevices() {
    const scan = state.scan;
    const phase = scan.phase === 'wired' ? t('scanningWired') : scan.phase === 'wireless' ? t('scanningWireless') : scan.phase === 'hotspot' ? t('scanningHotspot') : '';
    $('#panel-devices').innerHTML = `
      <div class="section-toolbar"><h2>${t('devices')}</h2><button class="icon-command" data-action="refresh-devices" title="${t('scan')}" ${scan.scanning || !state.environment.complete ? 'disabled' : ''}>${icon('refresh')}<span>${t('scan')}</span></button></div>
      ${scan.scanning ? `<div class="progress-line"><span></span><p>${escapeHtml(phase)}</p></div>` : ''}
      <div class="device-list">${scan.devices.length ? scan.devices.map(deviceRow).join('') : `<div class="empty-state">${icon('debug-disconnect')}<span>${t('noDevices')}</span></div>`}</div>
      ${scan.errors.length ? `<div class="scan-errors">${scan.errors.map((error) => `<p>${escapeHtml(runtimeText(error))}</p>`).join('')}</div>` : ''}`;
  }

  function deviceRow(device) {
    if (device.kind === 'hotspot') {
      return `<div class="device-row hotspot-row"><span class="device-icon">${icon('radio-tower')}</span><div class="device-main"><strong>${escapeHtml(device.ssid)}</strong><span>${t('hotspot')}</span><small>${t('hotspotHint')}</small></div><button class="icon-only" data-action="open-hotspot" title="${t('openPage')}">${icon('link-external')}</button></div>`;
    }
    const selected = state.selectedDevice?.key === device.key;
    const meta = device.kind === 'wired'
      ? `${t('wired')} · USB ${escapeHtml(device.vid)}:${escapeHtml(device.pid)}`
      : `${t('wireless')} · ${escapeHtml(device.ip)} · ID ${device.id}${device.reachable ? '' : ` · ${t('unreachable')}`}`;
    const swatch = device.kind === 'wireless' ? colorSwatch(device) : '';
    return `<div class="device-row ${selected ? 'selected' : ''}"><span class="device-icon">${icon(device.kind === 'wired' ? 'plug' : 'radio-tower')}</span><div class="device-main"><strong>${swatch}${escapeHtml(device.name)}</strong><span>${meta}</span></div><button class="select-button" data-action="select-device" data-key="${escapeHtml(device.key)}" ${device.kind === 'wireless' && !device.reachable ? 'disabled' : ''}>${selected ? t('selected') : t('select')}</button></div>`;
  }

  function renderConfiguration() {
    const project = state.project;
    const device = state.selectedDevice;
    const blockers = [];
    if (!state.environment.complete) blockers.push(t('environmentIncomplete'));
    if (!device) blockers.push(t('deviceRequired'));
    if (device?.kind === 'wireless' && !state.environment.openocd.capabilities?.wireless) blockers.push(t('wirelessOpenocdRequired'));
    if (!project) blockers.push(t('noWorkspace'));
    if (project?.elfSelectionRequired) blockers.push(t('confirmElf'));
    if (project?.targetSelectionRequired) blockers.push(t('confirmTarget'));
    if (project && !project.elfExists) blockers.push(t('buildFirst'));
    if (project && !project.targetConfigExists) blockers.push(project.targetConfig || t('target'));
    const canSave = blockers.length === 0;
    $('#configuration').innerHTML = `
      <div class="section-toolbar config-heading"><h2>${t('configuration')}</h2><div class="heading-actions">${state.workspaceCount > 1 ? `<button class="icon-only" data-action="choose-workspace" title="${t('switchProject')}">${icon('root-folder-opened')}</button>` : ''}</div></div>
      <h3 class="detail-label">${t('currentEnvironment')}</h3>
      <dl class="facts environment-facts">${environmentFact(state.environment.cortex)}${environmentFact(state.environment.gdb)}${environmentFact(state.environment.openocd)}</dl>
      ${device ? `<dl class="facts"><div><dt>${t('devices')}</dt><dd>${device.kind === 'wireless' ? colorSwatch(device) : ''}${escapeHtml(device.name)}</dd></div>${device.kind === 'wireless' ? `<div><dt>IP</dt><dd class="ip-value"><span>${escapeHtml(device.ip)}</span><button class="inline-command" data-action="open-page" title="${t('openPage')}">${icon('link-external')}<span>${t('openPage')}</span></button></dd></div>` : ''}</dl>` : ''}
      ${project ? `<dl class="facts project-facts"><div><dt>${t('workspace')}</dt><dd>${escapeHtml(project.workspaceName)}</dd></div><div><dt>${t('detector')}</dt><dd>${escapeHtml(t('source')[project.source] || project.source)}</dd></div><div><dt>${t('mcu')}</dt><dd>${escapeHtml(project.mcu || '--')}</dd></div></dl>
      <label class="speed-field"><span>${t('adapterSpeed')}</span><div><input type="number" data-setting="adapterSpeed" min="1" max="50000" step="100" value="${escapeHtml(String(state.adapterSpeed))}"><span>${t('kilohertz')}</span></div></label>
      <label class="path-field"><span>${t('elf')}</span><div><input data-project-field="elfPath" value="${escapeHtml(project.elfPath || '')}" class="${project.elfExists && !project.elfSelectionRequired ? '' : 'invalid'}"><button class="icon-only" data-action="choose-elf" title="${t('choose')}">${icon('folder-opened')}</button></div></label>
      <label class="path-field"><span>${t('target')}</span><div><input data-project-field="targetConfig" value="${escapeHtml(project.targetConfig || '')}" class="${project.targetConfigExists && !project.targetSelectionRequired ? '' : 'invalid'}"><button class="icon-only" data-action="choose-target" title="${t('choose')}">${icon('list-selection')}</button></div></label>` : ''}
      ${blockers.length ? `<div class="blockers">${blockers.map((item) => `<p>${icon('info')}<span>${escapeHtml(item)}</span></p>`).join('')}</div>` : ''}
      <button class="wide-command primary" data-action="save" ${canSave ? '' : 'disabled'}>${icon('save')}<span>${t('save')}</span></button>`;
  }

  function environmentFact(probe) {
    const value = probe.path || runtimeText(probe.error) || stateLabel(probe);
    const title = probe.version ? `${probe.version} · ${value}` : value;
    return `<div><dt>${escapeHtml(probe.label)}</dt><dd title="${escapeHtml(title)}"><span class="inline-state ${probe.state}"></span>${escapeHtml(title)}</dd></div>`;
  }

  function colorSwatch(device) {
    const id = Number.isInteger(device.id) && device.id >= 1 && device.id <= 10 ? device.id : 0;
    return `<span class="swatch color-id-${id}" title="${escapeHtml(t('colorId'))} ${escapeHtml(String(device.id))}"></span>`;
  }

  function runtimeText(value) {
    if (state?.locale !== 'zh-cn' || !value) return value;
    const translations = [
      [/^VS Code extension marus25\.cortex-debug is not installed\.$/, '未安装 VS Code 扩展 marus25.cortex-debug。'],
      [/^arm-none-eabi-gdb or gdb-multiarch was not found\.$/, '未找到 arm-none-eabi-gdb 或 gdb-multiarch。'],
      [/^OpenOCD was not found\.$/, '未找到 OpenOCD。'],
      [/^OpenOCD scripts directory was not found\.$/, '未找到 OpenOCD scripts 目录。'],
      [/^Wired mode is available, but wireless mode requires OpenOCD built from the latest master commit with CMSIS-DAP TCP support\.$/, '有线模式可用，但无线模式需要构建支持 CMSIS-DAP TCP 的 OpenOCD master 最新提交。'],
      [/^The operating system returned no Wi-Fi scan data\..*$/, '操作系统未返回 Wi-Fi 扫描数据，请检查 Wi-Fi 和定位权限。'],
      [/^Wi-Fi scan: /, 'Wi-Fi 扫描：'],
      [/^Wired probe: /, '有线探测：'],
      [/^AmphiLink is present but USB permission was denied\..*$/, '已发现 AmphiLink，但 USB 权限被拒绝，请安装 OpenOCD udev 规则。']
    ];
    const match = translations.find(([pattern]) => pattern.test(value));
    return match ? value.replace(match[0], match[1]) : value;
  }

  vscode.postMessage({ type: 'ready' });
})();
