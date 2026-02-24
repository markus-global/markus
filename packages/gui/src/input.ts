import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@markus/shared';

const execAsync = promisify(exec);
const log = createLogger('gui-input');

/**
 * Provides mouse and keyboard input to a Docker container
 * running a desktop environment via xdotool.
 */
export class DesktopInput {
  constructor(
    private containerId: string,
    private display: string = ':1',
  ) {}

  private async xdotool(command: string): Promise<string> {
    const fullCmd = `docker exec -e DISPLAY=${this.display} ${this.containerId} xdotool ${command}`;
    try {
      const { stdout } = await execAsync(fullCmd, { timeout: 10_000 });
      return stdout.trim();
    } catch (error) {
      log.error('xdotool command failed', { command, error: String(error) });
      throw error;
    }
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.xdotool(`mousemove ${x} ${y}`);
    log.debug(`Mouse moved to (${x}, ${y})`);
  }

  async click(x: number, y: number, button: 1 | 2 | 3 = 1): Promise<void> {
    await this.xdotool(`mousemove ${x} ${y} click ${button}`);
    log.debug(`Clicked at (${x}, ${y}) button=${button}`);
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await this.xdotool(`mousemove ${x} ${y} click --repeat 2 1`);
    log.debug(`Double-clicked at (${x}, ${y})`);
  }

  async rightClick(x: number, y: number): Promise<void> {
    await this.click(x, y, 3);
  }

  async type(text: string, delayMs: number = 50): Promise<void> {
    await this.xdotool(`type --delay ${delayMs} -- '${text.replace(/'/g, "'\\''")}'`);
    log.debug(`Typed: ${text.substring(0, 50)}...`);
  }

  async keyPress(...keys: string[]): Promise<void> {
    await this.xdotool(`key ${keys.join('+')}`);
    log.debug(`Key press: ${keys.join('+')}`);
  }

  async scroll(x: number, y: number, clicks: number): Promise<void> {
    const button = clicks > 0 ? 5 : 4;
    const count = Math.abs(clicks);
    await this.xdotool(`mousemove ${x} ${y} click --repeat ${count} ${button}`);
    log.debug(`Scrolled ${clicks} at (${x}, ${y})`);
  }

  async getMousePosition(): Promise<{ x: number; y: number }> {
    const output = await this.xdotool('getmouselocation');
    const match = output.match(/x:(\d+)\s+y:(\d+)/);
    if (!match) throw new Error(`Failed to parse mouse position: ${output}`);
    return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
  }

  async getActiveWindowTitle(): Promise<string> {
    try {
      return await this.xdotool('getactivewindow getwindowname');
    } catch {
      return '(no active window)';
    }
  }
}
