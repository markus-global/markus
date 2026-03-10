declare module 'tesseract.js' {
  interface Word {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }
  interface RecognizeResult {
    data: { text: string; words: Word[] };
  }
  export function recognize(
    image: Buffer | string,
    lang: string,
    options?: { logger?: (info: unknown) => void },
  ): Promise<RecognizeResult>;
}
