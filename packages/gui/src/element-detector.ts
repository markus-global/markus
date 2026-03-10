import { createLogger } from '@markus/shared';
import type { GUIElement, ScreenRegion, ElementQuery } from './types.js';

const log = createLogger('element-detector');

export interface ElementDetectorConfig {
  engine: 'omniparser' | 'tesseract';
  apiUrl?: string;
  confidence: number;
  timeout: number;
}

/**
 * GUI element detection using OmniParser API or local OCR fallback.
 */
export class ElementDetector {
  private config: ElementDetectorConfig;

  constructor(config: ElementDetectorConfig) {
    this.config = config;
  }

  /**
   * Detect all GUI elements in an image.
   * @param imageBase64 Base64-encoded PNG image
   */
  async detectElements(imageBase64: string): Promise<GUIElement[]> {
    if (this.config.engine === 'omniparser' && this.config.apiUrl) {
      return this.detectWithOmniParser(imageBase64);
    }
    return this.detectWithOCR(imageBase64);
  }

  /**
   * Find a specific element matching a query.
   */
  async findElement(imageBase64: string, query: ElementQuery): Promise<GUIElement | null> {
    const elements = await this.detectElements(imageBase64);

    for (const el of elements) {
      if (query.type && el.type !== query.type) continue;

      if (query.text) {
        const searchText = query.text.toLowerCase();
        const elText = (el.text ?? el.label ?? '').toLowerCase();
        if (!elText.includes(searchText)) continue;
      }

      if (query.near) {
        const cx = el.bounds.x + el.bounds.width / 2;
        const cy = el.bounds.y + el.bounds.height / 2;
        const dist = Math.sqrt((cx - query.near.x) ** 2 + (cy - query.near.y) ** 2);
        if (dist > 200) continue;
      }

      if (el.confidence >= this.config.confidence) return el;
    }

    return null;
  }

  /**
   * Extract text from a region of the image using OCR.
   */
  async extractText(imageBase64: string, region?: ScreenRegion): Promise<string> {
    if (this.config.engine === 'omniparser' && this.config.apiUrl) {
      return this.ocrWithOmniParser(imageBase64, region);
    }
    return this.ocrWithTesseract(imageBase64, region);
  }

  // ── OmniParser API integration ──────────────────────────────────────────────

  private async detectWithOmniParser(imageBase64: string): Promise<GUIElement[]> {
    if (!this.config.apiUrl) return [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeout);

      const resp = await fetch(`${this.config.apiUrl}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageBase64, return_text: true }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        log.warn('OmniParser detection failed', { status: resp.status });
        return this.detectWithOCR(imageBase64);
      }

      const data = await resp.json() as {
        elements: Array<{
          id?: string;
          type: string;
          label?: string;
          text?: string;
          bbox: [number, number, number, number]; // [x, y, w, h]
          confidence: number;
          attributes?: Record<string, string>;
        }>;
      };

      return (data.elements ?? []).map((el, idx) => ({
        id: el.id ?? `el_${idx}`,
        type: mapElementType(el.type),
        label: el.label,
        text: el.text,
        bounds: {
          x: el.bbox[0],
          y: el.bbox[1],
          width: el.bbox[2],
          height: el.bbox[3],
        },
        confidence: el.confidence,
        attributes: el.attributes,
      }));
    } catch (err) {
      log.warn('OmniParser detection error, falling back to OCR', { error: String(err) });
      return this.detectWithOCR(imageBase64);
    }
  }

  private async ocrWithOmniParser(imageBase64: string, region?: ScreenRegion): Promise<string> {
    if (!this.config.apiUrl) return '';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeout);

      const resp = await fetch(`${this.config.apiUrl}/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageBase64, region }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) return '';
      const data = await resp.json() as { text: string };
      return data.text ?? '';
    } catch {
      return '';
    }
  }

  // ── Tesseract.js OCR fallback ───────────────────────────────────────────────

  private async detectWithOCR(imageBase64: string): Promise<GUIElement[]> {
    try {
      const Tesseract = await import('tesseract.js');
      const imgBuffer = Buffer.from(imageBase64, 'base64');

      const result = await Tesseract.recognize(imgBuffer, 'eng', {
        logger: () => {},
      });

      const elements: GUIElement[] = [];
      const words = result.data?.words ?? [];

      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        if (word.confidence < this.config.confidence * 100) continue;

        elements.push({
          id: `ocr_${i}`,
          type: 'text',
          text: word.text,
          bounds: {
            x: word.bbox.x0,
            y: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          },
          confidence: word.confidence / 100,
        });
      }

      log.debug('OCR detected text elements', { count: elements.length });
      return elements;
    } catch (err) {
      log.warn('Tesseract OCR not available', { error: String(err) });
      return [];
    }
  }

  private async ocrWithTesseract(imageBase64: string, _region?: ScreenRegion): Promise<string> {
    try {
      const Tesseract = await import('tesseract.js');
      const imgBuffer = Buffer.from(imageBase64, 'base64');
      const result = await Tesseract.recognize(imgBuffer, 'eng', { logger: () => {} });
      return result.data?.text ?? '';
    } catch {
      return '';
    }
  }
}

function mapElementType(type: string): GUIElement['type'] {
  const mapping: Record<string, GUIElement['type']> = {
    button: 'button',
    btn: 'button',
    input: 'input',
    textfield: 'input',
    text: 'text',
    label: 'text',
    link: 'link',
    anchor: 'link',
    image: 'image',
    img: 'image',
    checkbox: 'checkbox',
    check: 'checkbox',
    dropdown: 'dropdown',
    select: 'dropdown',
    combobox: 'dropdown',
  };
  return mapping[type.toLowerCase()] ?? 'unknown';
}
