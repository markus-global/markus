import { createLogger } from '@markus/shared';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VNCClient } from './vnc-client.js';
import type { ScreenRegion, ScreenshotResult } from './types.js';

const log = createLogger('gui-screenshot');

/**
 * Captures screenshots from a VNC connection and saves them as PNG/JPEG files.
 */
export class ScreenshotProvider {
  private vncClient: VNCClient;
  private screenshotDir: string;
  private format: 'png' | 'jpeg';
  private quality: number;

  constructor(vncClient: VNCClient, opts: { screenshotDir: string; format?: 'png' | 'jpeg'; quality?: number }) {
    this.vncClient = vncClient;
    this.screenshotDir = opts.screenshotDir;
    this.format = opts.format ?? 'png';
    this.quality = opts.quality ?? 90;

    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  /**
   * Capture a screenshot and save it to disk.
   */
  async capture(region?: ScreenRegion, filename?: string): Promise<ScreenshotResult> {
    const { data, width, height } = await this.vncClient.captureScreen(region);

    const ts = Date.now();
    const name = filename ?? `screenshot-${ts}.${this.format}`;
    const outputPath = join(this.screenshotDir, name);

    try {
      const sharp = (await import('sharp')).default;

      // VNC framebuffer is BGRA; sharp needs RGBA
      const rgbaData = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i += 4) {
        rgbaData[i] = data[i + 2]!;     // R <- B
        rgbaData[i + 1] = data[i + 1]!; // G
        rgbaData[i + 2] = data[i]!;     // B <- R
        rgbaData[i + 3] = data[i + 3]!; // A
      }

      const img = sharp(rgbaData, { raw: { width, height, channels: 4 } });

      if (this.format === 'jpeg') {
        await img.jpeg({ quality: this.quality }).toFile(outputPath);
      } else {
        await img.png().toFile(outputPath);
      }

      log.debug('Screenshot saved', { path: outputPath, width, height });
    } catch (err) {
      log.warn('sharp not available, saving raw RGBA data', { error: String(err) });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outputPath + '.raw', data);
    }

    return {
      path: outputPath,
      width,
      height,
      format: this.format,
      timestamp: ts,
    };
  }

  /**
   * Capture a screenshot and return it as a base64 PNG string.
   */
  async captureBase64(region?: ScreenRegion): Promise<string> {
    const { data, width, height } = await this.vncClient.captureScreen(region);

    try {
      const sharp = (await import('sharp')).default;

      const rgbaData = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i += 4) {
        rgbaData[i] = data[i + 2]!;
        rgbaData[i + 1] = data[i + 1]!;
        rgbaData[i + 2] = data[i]!;
        rgbaData[i + 3] = data[i + 3]!;
      }

      const buf = await sharp(rgbaData, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
      return buf.toString('base64');
    } catch {
      return data.toString('base64');
    }
  }
}
