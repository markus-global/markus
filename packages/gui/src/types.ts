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

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  format: 'png' | 'jpeg';
  timestamp: number;
}

export interface Position {
  x: number;
  y: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

export interface GUIElement {
  id: string;
  type: 'button' | 'input' | 'text' | 'link' | 'image' | 'checkbox' | 'dropdown' | 'unknown';
  label?: string;
  text?: string;
  bounds: ScreenRegion;
  confidence: number;
  attributes?: Record<string, string>;
}

export interface ElementQuery {
  text?: string;
  type?: GUIElement['type'];
  near?: Position;
}

export interface GUIConfig {
  vnc: VNCConfig;
  screenshot: {
    dir: string;
    format: 'png' | 'jpeg';
    quality: number;
  };
  detection?: {
    engine: 'omniparser' | 'tesseract';
    apiUrl?: string;
    confidence: number;
    timeout: number;
  };
}
