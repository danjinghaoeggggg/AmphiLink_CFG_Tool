export type ProbeState = 'idle' | 'checking' | 'ready' | 'limited' | 'missing' | 'incompatible' | 'error';

export interface OpenOcdCapabilities {
  wired: boolean;
  wireless: boolean;
}

export interface ToolProbeResult {
  id: 'cortex' | 'gdb' | 'openocd';
  label: string;
  state: ProbeState;
  path?: string;
  scriptsPath?: string;
  version?: string;
  source?: string;
  details: string[];
  error?: string;
  capabilities?: OpenOcdCapabilities;
}

export interface EnvironmentStatus {
  checking: boolean;
  cortex: ToolProbeResult;
  gdb: ToolProbeResult;
  openocd: ToolProbeResult;
  complete: boolean;
  checkedAt?: string;
}

export const AMPHILINK_USB_DEVICE = {
  vid: '303A',
  pid: '83B3',
  product: 'AmphiLink (CMSIS-DAP V2)'
} as const;

export const AMPHILINK_COLORS = [
  { id: 1, name: 'red', hex: '#ff0000' },
  { id: 2, name: 'orange', hex: '#ff5000' },
  { id: 3, name: 'yellow', hex: '#ffdc00' },
  { id: 4, name: 'green', hex: '#00ff00' },
  { id: 5, name: 'cyan', hex: '#00ffff' },
  { id: 6, name: 'blue', hex: '#0000ff' },
  { id: 7, name: 'purple', hex: '#8000ff' },
  { id: 8, name: 'magenta', hex: '#ff00ff' },
  { id: 9, name: 'pink', hex: '#ff4080' },
  { id: 10, name: 'white', hex: '#ffffff' }
] as const;

export type AmphiLinkColor = (typeof AMPHILINK_COLORS)[number];

export interface WiredDevice {
  key: string;
  kind: 'wired';
  name: string;
  transport: 'usb';
  vid: typeof AMPHILINK_USB_DEVICE.vid;
  pid: typeof AMPHILINK_USB_DEVICE.pid;
}

export interface WirelessDevice {
  key: string;
  kind: 'wireless';
  name: string;
  transport: 'tcp';
  id: number;
  color: AmphiLinkColor;
  ip: string;
  port: 4441;
  reachable: boolean;
}

export interface HotspotDevice {
  key: string;
  kind: 'hotspot';
  name: string;
  ssid: string;
  ip: '192.168.4.1';
}

export type DetectedDevice = WiredDevice | WirelessDevice | HotspotDevice;
export type SelectableDevice = WiredDevice | WirelessDevice;

export type DeviceScanPhase = 'idle' | 'wired' | 'wireless' | 'hotspot' | 'done';

export interface DeviceScanStatus {
  scanning: boolean;
  phase: DeviceScanPhase;
  devices: DetectedDevice[];
  errors: string[];
  scannedAt?: string;
}

export type ProjectSource =
  | 'cubemx-cmake'
  | 'existing-launch'
  | 'cmake-file-api'
  | 'generic-cmake'
  | 'platformio'
  | 'elf-scan'
  | 'manual'
  | 'none';

export interface ProjectProfile {
  workspacePath: string;
  workspaceName: string;
  source: ProjectSource;
  confidence: number;
  projectName?: string;
  mcu?: string;
  family?: string;
  buildType?: string;
  elfPath?: string;
  elfExists: boolean;
  elfCandidates: string[];
  elfSelectionRequired: boolean;
  targetConfig?: string;
  targetConfigExists: boolean;
  targetCandidates: string[];
  targetSelectionRequired: boolean;
  svdPath?: string;
  warnings: string[];
}

export interface ExtensionState {
  locale: 'zh-cn' | 'en';
  workspaceCount: number;
  adapterSpeed: number;
  environment: EnvironmentStatus;
  scan: DeviceScanStatus;
  selectedDevice?: SelectableDevice;
  project?: ProjectProfile;
  busyMessage?: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refreshEnvironment' }
  | { type: 'refreshDevices' }
  | { type: 'selectDevice'; key: string }
  | { type: 'openDevicePage'; hotspot?: boolean }
  | { type: 'saveProject' }
  | { type: 'chooseToolPath'; tool: 'gdb' | 'openocd' | 'scripts' }
  | { type: 'installTool'; tool: 'cortex' | 'gdb' | 'openocd' }
  | { type: 'chooseElf' }
  | { type: 'chooseTarget' }
  | { type: 'chooseWorkspace' }
  | { type: 'setAdapterSpeed'; value: number }
  | { type: 'setProjectField'; field: 'elfPath' | 'targetConfig'; value: string };

export interface ProcessResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}
