import * as net from 'node:net';
import type { WirelessSerialState } from '../types';

export const WIRELESS_SERIAL_PORT = 4443 as const;

export class WirelessSerialService {
  private socket?: net.Socket;
  private connectionId = 0;
  private current: WirelessSerialState = initialState();

  constructor(
    private readonly onState: (state: WirelessSerialState) => void,
    private readonly onData: (data: number[], rxBytes: number) => void
  ) {}

  get state(): WirelessSerialState {
    return { ...this.current };
  }

  connect(host: string, deviceKey: string): void {
    this.closeSocket();
    const id = ++this.connectionId;
    this.current = {
      status: 'connecting', deviceKey, host, port: WIRELESS_SERIAL_PORT,
      rxBytes: 0, txBytes: 0
    };
    this.report();

    const socket = net.createConnection({ host, port: WIRELESS_SERIAL_PORT });
    this.socket = socket;
    socket.setTimeout(1800);
    socket.once('connect', () => {
      if (!this.isCurrent(id, socket)) return;
      socket.setTimeout(0);
      this.current = { ...this.current, status: 'connected', error: undefined };
      this.report();
    });
    socket.on('data', (chunk: Buffer) => {
      if (!this.isCurrent(id, socket)) return;
      const data = [...chunk];
      this.current = { ...this.current, rxBytes: this.current.rxBytes + data.length };
      // RX can be continuous. Keep the hot path as a data-only notification so
      // consumers do not rebuild their whole UI for every network chunk.
      this.onData(data, this.current.rxBytes);
    });
    socket.once('timeout', () => {
      if (!this.isCurrent(id, socket)) return;
      this.fail(socket, id, 'Connection timed out.');
    });
    socket.once('error', (error) => {
      if (!this.isCurrent(id, socket)) return;
      this.current = { ...this.current, status: 'error', error: error.message };
      this.report();
    });
    socket.once('close', () => {
      if (!this.isCurrent(id, socket)) return;
      this.socket = undefined;
      if (this.current.status !== 'error') {
        this.current = { ...this.current, status: 'disconnected' };
      }
      this.report();
    });
  }

  disconnect(): void {
    this.connectionId += 1;
    const hadConnection = Boolean(this.socket) || this.current.status !== 'idle';
    this.closeSocket();
    if (hadConnection) {
      this.current = { ...this.current, status: 'disconnected', error: undefined };
      this.report();
    }
  }

  send(data: number[]): void {
    if (this.current.status !== 'connected' || !this.socket?.writable) {
      throw new Error('Wireless serial is not connected.');
    }
    const payload = Buffer.from(data);
    this.socket.write(payload);
    this.current = { ...this.current, txBytes: this.current.txBytes + payload.length };
    this.report();
  }

  dispose(): void {
    this.connectionId += 1;
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }

  private fail(socket: net.Socket, id: number, error: string): void {
    if (!this.isCurrent(id, socket)) return;
    this.current = { ...this.current, status: 'error', error };
    this.report();
    socket.destroy();
  }

  private isCurrent(id: number, socket: net.Socket): boolean {
    return id === this.connectionId && socket === this.socket;
  }

  private report(): void {
    this.onState(this.state);
  }
}

function initialState(): WirelessSerialState {
  return { status: 'idle', port: WIRELESS_SERIAL_PORT, rxBytes: 0, txBytes: 0 };
}
