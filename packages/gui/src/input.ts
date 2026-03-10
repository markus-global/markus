import { createLogger } from '@markus/shared';
import type { VNCClient } from './vnc-client.js';
import type { Position, MouseButton } from './types.js';

const log = createLogger('gui-input');

const BUTTON_MASK: Record<MouseButton, number> = {
  left: 1,
  middle: 2,
  right: 4,
};

/**
 * X11 keysym values for common keys.
 * Full list: https://www.cl.cam.ac.uk/~mgk25/ucs/keysymdef.h
 */
const KEYSYM: Record<string, number> = {
  Return: 0xff0d,
  Enter: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  BackSpace: 0xff08,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Insert: 0xff63,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1,
  F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5,
  F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  Shift_L: 0xffe1, Shift_R: 0xffe2,
  Control_L: 0xffe3, Control_R: 0xffe4,
  Alt_L: 0xffe9, Alt_R: 0xffea,
  Meta_L: 0xffe7, Super_L: 0xffeb,
  space: 0x0020,
};

function charToKeysym(char: string): number {
  if (KEYSYM[char] !== undefined) return KEYSYM[char]!;
  const code = char.charCodeAt(0);
  // Latin-1 range maps directly
  if (code >= 0x20 && code <= 0xff) return code;
  // Unicode BMP: keysym = 0x01000000 + unicode codepoint
  return 0x01000000 + code;
}

/**
 * Desktop input controller via VNC protocol.
 * Sends mouse and keyboard events through the VNC client.
 */
export class DesktopInput {
  private vncClient: VNCClient;
  private currentX = 0;
  private currentY = 0;

  constructor(vncClient: VNCClient) {
    this.vncClient = vncClient;
  }

  async mouseMove(x: number, y: number): Promise<void> {
    this.currentX = x;
    this.currentY = y;
    await this.vncClient.sendPointerEvent(x, y, 0);
  }

  async mouseClick(x: number, y: number, button: MouseButton = 'left'): Promise<void> {
    const mask = BUTTON_MASK[button];
    this.currentX = x;
    this.currentY = y;
    // Move to position
    await this.vncClient.sendPointerEvent(x, y, 0);
    await sleep(30);
    // Press
    await this.vncClient.sendPointerEvent(x, y, mask);
    await sleep(50);
    // Release
    await this.vncClient.sendPointerEvent(x, y, 0);
  }

  async mouseDoubleClick(x: number, y: number, button: MouseButton = 'left'): Promise<void> {
    await this.mouseClick(x, y, button);
    await sleep(80);
    await this.mouseClick(x, y, button);
  }

  async scroll(x: number, y: number, direction: 'up' | 'down', amount: number = 3): Promise<void> {
    // VNC scroll: button 4 = scroll up, button 5 = scroll down
    const mask = direction === 'up' ? 8 : 16;
    for (let i = 0; i < amount; i++) {
      await this.vncClient.sendPointerEvent(x, y, mask);
      await sleep(30);
      await this.vncClient.sendPointerEvent(x, y, 0);
      await sleep(30);
    }
  }

  async keyPress(key: string): Promise<void> {
    const keysym = KEYSYM[key] ?? charToKeysym(key);
    await this.vncClient.sendKeyEvent(keysym, true);
    await sleep(30);
    await this.vncClient.sendKeyEvent(keysym, false);
  }

  async keyDown(key: string): Promise<void> {
    const keysym = KEYSYM[key] ?? charToKeysym(key);
    await this.vncClient.sendKeyEvent(keysym, true);
  }

  async keyUp(key: string): Promise<void> {
    const keysym = KEYSYM[key] ?? charToKeysym(key);
    await this.vncClient.sendKeyEvent(keysym, false);
  }

  /**
   * Type text character by character with small delays.
   */
  async typeText(text: string, delayMs: number = 30): Promise<void> {
    for (const char of text) {
      const keysym = charToKeysym(char);
      await this.vncClient.sendKeyEvent(keysym, true);
      await sleep(delayMs);
      await this.vncClient.sendKeyEvent(keysym, false);
      await sleep(delayMs);
    }
  }

  /**
   * Press a key combination (e.g., ['Control_L', 'c'] for Ctrl+C).
   */
  async keyCombination(keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.keyDown(key);
      await sleep(20);
    }
    for (const key of [...keys].reverse()) {
      await this.keyUp(key);
      await sleep(20);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
