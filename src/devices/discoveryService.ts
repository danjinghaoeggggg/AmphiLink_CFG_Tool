import * as dgram from 'node:dgram';
import { access } from 'node:fs/promises';
import * as net from 'node:net';
import { AMPHILINK_COLORS, AMPHILINK_USB_DEVICE, type DeviceScanStatus, type HotspotDevice, type WirelessDevice, type WiredDevice } from '../types';
import { processOutput, runProcess } from '../core/process';

const DISCOVERY_PORT = 4442;
const DEBUG_PORT = 4441;

interface DiscoveryPayload {
  name: string;
  id: number;
}

export function parseDiscoveryPayload(data: Buffer): DiscoveryPayload | undefined {
  if (data.length === 0 || data.length > 256) {
    return undefined;
  }
  const text = data.toString('utf8');
  if (text.includes('\ufffd') || Buffer.byteLength(text, 'utf8') !== data.length) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || !Number.isInteger(record.id)) {
      return undefined;
    }
    const nameBytes = Buffer.byteLength(record.name, 'utf8');
    if (nameBytes < 1 || nameBytes > 32 || hasControlCharacter(record.name)
      || record.id as number < 1 || record.id as number > 10) {
      return undefined;
    }
    return { name: record.name, id: record.id as number };
  } catch {
    return undefined;
  }
}

export function parseHotspotNames(output: string): string[] {
  return [...new Set(output.match(/AmphiLink-[A-Za-z0-9_-]+/g) ?? [])].sort();
}

export class DiscoveryService {
  private controller?: AbortController;

  cancel(): void {
    this.controller?.abort();
  }

  async scan(openocdPath: string, onProgress?: (status: DeviceScanStatus) => void): Promise<DeviceScanStatus> {
    this.cancel();
    this.controller = new AbortController();
    const status: DeviceScanStatus = { scanning: true, phase: 'wired', devices: [], errors: [] };
    const report = (): void => onProgress?.(structuredClone(status));
    report();

    try {
      const wired = await this.detectWired(openocdPath, this.controller.signal);
      if (wired) {
        status.devices.push(wired);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        status.errors.push(errorMessage('Wired probe', error));
      }
    }
    if (this.controller.signal.aborted) {
      return finishCancelled(status, report);
    }
    status.phase = 'wireless';
    report();

    try {
      status.devices.push(...await this.detectWireless(this.controller.signal));
    } catch (error) {
      if (!this.controller.signal.aborted) {
        status.errors.push(errorMessage('Wireless discovery', error));
      }
    }
    if (this.controller.signal.aborted) {
      return finishCancelled(status, report);
    }
    status.phase = 'hotspot';
    report();

    try {
      status.devices.push(...await this.detectHotspots(this.controller.signal));
    } catch (error) {
      status.errors.push(errorMessage('Wi-Fi scan', error));
    }

    status.phase = 'done';
    status.scanning = false;
    status.scannedAt = new Date().toISOString();
    report();
    return status;
  }

  private async detectWired(openocdPath: string, signal: AbortSignal): Promise<WiredDevice | undefined> {
    const args = [
      '-c', 'adapter driver cmsis-dap',
      '-c', 'cmsis-dap backend usb_bulk',
      '-c', `cmsis_dap_vid_pid 0x${AMPHILINK_USB_DEVICE.vid} 0x${AMPHILINK_USB_DEVICE.pid}`,
      '-c', 'transport select swd',
      '-c', 'adapter speed 1000',
      '-c', 'init',
      '-c', 'shutdown'
    ];
    const result = await runProcess(openocdPath, args, { timeoutMs: 7000, signal });
    const output = processOutput(result);
    if (result.code === 0) {
      return {
        key: `wired:${AMPHILINK_USB_DEVICE.vid.toLowerCase()}:${AMPHILINK_USB_DEVICE.pid.toLowerCase()}`,
        kind: 'wired', name: AMPHILINK_USB_DEVICE.product,
        transport: 'usb', vid: AMPHILINK_USB_DEVICE.vid, pid: AMPHILINK_USB_DEVICE.pid
      };
    }
    if (/permission denied|access denied|LIBUSB_ERROR_ACCESS/i.test(output)) {
      throw new Error('AmphiLink is present but USB permission was denied. Install the OpenOCD udev rule.');
    }
    if (/unable to find a matching CMSIS-DAP device|no device found|not found/i.test(output)) {
      return undefined;
    }
    if (result.error && result.error !== 'Cancelled') {
      throw new Error(result.error);
    }
    return undefined;
  }

  private detectWireless(signal: AbortSignal): Promise<WirelessDevice[]> {
    return new Promise((resolve, reject) => {
      const devices = new Map<string, WirelessDevice>();
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.close();
        if (error) {
          reject(error);
        } else {
          resolve([...devices.values()].sort((a, b) => a.name.localeCompare(b.name)));
        }
      };
      const abort = (): void => finish(new Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      socket.on('error', (error) => finish(error));
      socket.on('message', (message, remote) => {
        const payload = parseDiscoveryPayload(message);
        if (!payload || !net.isIPv4(remote.address)) {
          return;
        }
        const color = AMPHILINK_COLORS[payload.id - 1];
        if (!color) {
          return;
        }
        devices.set(remote.address, {
          key: `wireless:${remote.address}`, kind: 'wireless', transport: 'tcp',
          name: payload.name, id: payload.id, color, ip: remote.address, port: DEBUG_PORT,
          reachable: false
        });
      });
      socket.bind(DISCOVERY_PORT, '0.0.0.0');
      const timer = setTimeout(async () => {
        await Promise.all([...devices.values()].map(async (device) => {
          device.reachable = await canConnect(device.ip, device.port, 900);
        }));
        finish();
      }, 6500);
    });
  }

  private async detectHotspots(signal: AbortSignal): Promise<HotspotDevice[]> {
    const command = await wifiScanCommand();
    const result = await runProcess(command.command, command.args, { timeoutMs: 15000, signal });
    if (result.code !== 0) {
      throw new Error(result.error ?? (processOutput(result) || 'The operating system Wi-Fi scan failed.'));
    }
    const output = processOutput(result);
    if (!output.trim()) {
      throw new Error('The operating system returned no Wi-Fi scan data. Check Wi-Fi and location permissions.');
    }
    return parseHotspotNames(output).map((ssid) => ({
      key: `hotspot:${ssid}`, kind: 'hotspot', name: ssid, ssid, ip: '192.168.4.1'
    }));
  }
}

function finishCancelled(status: DeviceScanStatus, report: () => void): DeviceScanStatus {
  status.phase = 'done';
  status.scanning = false;
  report();
  return status;
}

async function wifiScanCommand(): Promise<{ command: string; args: string[] }> {
  if (process.platform === 'win32') {
    return { command: 'netsh', args: ['wlan', 'show', 'networks', 'mode=bssid'] };
  }
  if (process.platform === 'linux') {
    return { command: 'nmcli', args: ['-t', '-f', 'SSID', 'device', 'wifi', 'list', '--rescan', 'yes'] };
  }
  const airport = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
  try {
    await access(airport);
    return { command: airport, args: ['-s'] };
  } catch {
    return { command: 'system_profiler', args: ['SPAirPortDataType', '-detailLevel', 'mini'] };
  }
}

export function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function errorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
