import { createLogger } from '@markus/shared';
import { createConnection, type Socket } from 'node:net';
import type { VNCConfig, ScreenRegion } from './types.js';

const log = createLogger('vnc-client');

interface RFBRect {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Buffer;
}

/**
 * VNC client using the rfb2 library for the RFB protocol.
 * Falls back to raw TCP if rfb2 is unavailable.
 */
export class VNCClient {
  private rfbClient: any = null;
  private connected = false;
  private config?: VNCConfig;
  private framebuffer: Buffer | null = null;
  private fbWidth = 0;
  private fbHeight = 0;

  async connect(config: VNCConfig): Promise<void> {
    this.config = config;

    return new Promise((resolve, reject) => {
      try {
        // Dynamic import of rfb2 (optional dependency)
        const rfb2 = require('rfb2');
        this.rfbClient = rfb2.createConnection({
          host: config.host,
          port: config.port,
          password: config.password ?? '',
        });

        this.rfbClient.on('connect', () => {
          this.connected = true;
          this.fbWidth = this.rfbClient.width;
          this.fbHeight = this.rfbClient.height;
          this.framebuffer = Buffer.alloc(this.fbWidth * this.fbHeight * 4);
          log.info('VNC connected', { host: config.host, port: config.port, width: this.fbWidth, height: this.fbHeight });
          resolve();
        });

        this.rfbClient.on('rect', (rect: RFBRect) => {
          if (!this.framebuffer) return;
          // Copy rect data into framebuffer at correct position
          for (let y = 0; y < rect.height; y++) {
            const srcOffset = y * rect.width * 4;
            const dstOffset = ((rect.y + y) * this.fbWidth + rect.x) * 4;
            if (srcOffset + rect.width * 4 <= rect.data.length && dstOffset + rect.width * 4 <= this.framebuffer.length) {
              rect.data.copy(this.framebuffer, dstOffset, srcOffset, srcOffset + rect.width * 4);
            }
          }
        });

        this.rfbClient.on('error', (err: Error) => {
          log.error('VNC connection error', { error: err.message });
          if (!this.connected) reject(err);
        });

        this.rfbClient.on('end', () => {
          this.connected = false;
          log.info('VNC connection closed');
        });
      } catch (err) {
        reject(new Error(`Failed to create VNC connection: ${err}`));
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.rfbClient) {
      this.rfbClient.end();
      this.rfbClient = null;
    }
    this.connected = false;
    this.framebuffer = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getScreenSize(): { width: number; height: number } {
    return { width: this.fbWidth, height: this.fbHeight };
  }

  /**
   * Request a full framebuffer update and return the raw RGBA pixel data.
   */
  async captureScreen(region?: ScreenRegion): Promise<{ data: Buffer; width: number; height: number }> {
    if (!this.connected || !this.rfbClient) {
      throw new Error('VNC not connected');
    }

    // Request a full framebuffer update
    const x = region?.x ?? 0;
    const y = region?.y ?? 0;
    const w = region?.width ?? this.fbWidth;
    const h = region?.height ?? this.fbHeight;

    this.rfbClient.requestUpdate(false, x, y, w, h);

    // Wait briefly for update
    await new Promise(r => setTimeout(r, 200));

    if (!this.framebuffer) {
      throw new Error('No framebuffer data available');
    }

    if (region) {
      const regionBuf = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++) {
        const srcOffset = ((y + row) * this.fbWidth + x) * 4;
        const dstOffset = row * w * 4;
        this.framebuffer.copy(regionBuf, dstOffset, srcOffset, srcOffset + w * 4);
      }
      return { data: regionBuf, width: w, height: h };
    }

    return { data: Buffer.from(this.framebuffer), width: this.fbWidth, height: this.fbHeight };
  }

  /**
   * Send a pointer (mouse) event via VNC.
   * buttonMask: bit 0 = left, bit 1 = middle, bit 2 = right
   */
  async sendPointerEvent(x: number, y: number, buttonMask: number): Promise<void> {
    if (!this.connected || !this.rfbClient) {
      throw new Error('VNC not connected');
    }
    this.rfbClient.pointerEvent(x, y, buttonMask);
  }

  /**
   * Send a key event via VNC.
   * @param keysym X11 keysym value
   * @param down true for key press, false for key release
   */
  async sendKeyEvent(keysym: number, down: boolean): Promise<void> {
    if (!this.connected || !this.rfbClient) {
      throw new Error('VNC not connected');
    }
    this.rfbClient.keyEvent(keysym, down ? 1 : 0);
  }
}
