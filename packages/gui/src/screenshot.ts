import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@markus/shared';
import { readFileSync, existsSync } from 'node:fs';

const execAsync = promisify(exec);
const log = createLogger('screenshot');

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  timestamp: string;
  base64?: string;
}

export interface ScreenshotProvider {
  capture(outputPath: string): Promise<ScreenshotResult>;
}

/**
 * Captures screenshots from a Docker container running a desktop environment.
 * Uses xdotool/import (ImageMagick) inside the container.
 */
export class DockerScreenshotProvider implements ScreenshotProvider {
  constructor(
    private containerId: string,
    private display: string = ':1',
  ) {}

  async capture(outputPath: string): Promise<ScreenshotResult> {
    const containerOutputPath = `/tmp/screenshot_${Date.now()}.png`;

    try {
      await execAsync(
        `docker exec -e DISPLAY=${this.display} ${this.containerId} ` +
        `import -window root ${containerOutputPath}`,
        { timeout: 15_000 },
      );

      await execAsync(
        `docker cp ${this.containerId}:${containerOutputPath} ${outputPath}`,
        { timeout: 10_000 },
      );

      // Get dimensions
      const { stdout } = await execAsync(
        `docker exec -e DISPLAY=${this.display} ${this.containerId} ` +
        `xdotool getdisplaygeometry`,
        { timeout: 5_000 },
      );
      const [w, h] = stdout.trim().split(' ').map(Number);

      // Cleanup inside container
      await execAsync(
        `docker exec ${this.containerId} rm -f ${containerOutputPath}`,
      ).catch(() => {});

      const result: ScreenshotResult = {
        path: outputPath,
        width: w || 1920,
        height: h || 1080,
        timestamp: new Date().toISOString(),
      };

      log.debug('Screenshot captured', { path: result.path, width: result.width, height: result.height });
      return result;
    } catch (error) {
      log.error('Screenshot capture failed', { error: String(error) });
      throw error;
    }
  }
}

/**
 * Reads a screenshot file and returns its base64-encoded content
 * for sending to vision-capable LLMs.
 */
export function screenshotToBase64(path: string): string {
  if (!existsSync(path)) throw new Error(`Screenshot not found: ${path}`);
  const buffer = readFileSync(path);
  return buffer.toString('base64');
}
