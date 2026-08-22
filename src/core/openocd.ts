import { AMPHILINK_USB_DEVICE } from '../types';

const OPENOCD_TCP_ARGS = [
  '-c', 'adapter driver cmsis-dap',
  '-c', 'cmsis-dap backend tcp',
  '-c', 'cmsis-dap tcp host 127.0.0.1',
  '-c', 'cmsis-dap tcp port 4441',
  '-c', 'cmsis-dap tcp min_timeout 300',
  '-c', 'shutdown'
];

const OPENOCD_USB_ARGS = [
  '-c', 'adapter driver cmsis-dap',
  '-c', 'cmsis-dap backend usb_bulk',
  '-c', `cmsis_dap_vid_pid 0x${AMPHILINK_USB_DEVICE.vid} 0x${AMPHILINK_USB_DEVICE.pid}`,
  '-c', 'shutdown'
];

export function openOcdTcpProbeArgs(): string[] {
  return [...OPENOCD_TCP_ARGS];
}

export function openOcdUsbProbeArgs(): string[] {
  return [...OPENOCD_USB_ARGS];
}

export function acceptsOpenOcdTcpProbe(code: number | null, output: string): boolean {
  return code === 0
    && !/invalid command name|invalid backend|not (available|built)|unknown command/i.test(output);
}

export function acceptsOpenOcdUsbProbe(code: number | null, output: string): boolean {
  return code === 0
    && !/invalid command name|invalid backend|not (available|built)|unknown command/i.test(output);
}
