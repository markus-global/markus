import { createConnection, type Socket } from 'node:net';
import { createLogger } from '@markus/shared';

const log = createLogger('vnc-client');

export interface VNCConfig {
  host: string;
  port: number;
  password?: string;
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Lightweight VNC client for GUI automation.
 * Connects to a VNC server running inside an agent's sandbox container
 * and provides basic screen capture + input capabilities.
 *
 * For the Phase 2 prototype we use Docker exec + screenshot commands
 * rather than implementing the full RFB protocol. In Phase 3 this will
 * be replaced with a proper RFB implementation.
 */
export class VNCClient {
  private config: VNCConfig;
  private socket?: Socket;
  private connected = false;

  constructor(config: VNCConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection({
        host: this.config.host,
        port: this.config.port,
      });

      const timeout = setTimeout(() => {
        reject(new Error('VNC connection timeout'));
        this.socket?.destroy();
      }, 10_000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        log.info('VNC connected', { host: this.config.host, port: this.config.port });
        resolve();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        log.error('VNC connection error', { error: String(err) });
        reject(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        log.info('VNC disconnected');
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
      this.connected = false;
    }
  }
}
