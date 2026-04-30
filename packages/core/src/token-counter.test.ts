import { describe, it, expect } from 'vitest';
import { SmartTokenCounter } from './token-counter.js';

/* ------------------------------------------------------------------ */
/*  analyze_image-related token counter tests                          */
/* ------------------------------------------------------------------ */

describe('SmartTokenCounter.estimateImageTokens', () => {
  /** A very small data URL (~100 bytes after base64) */
  const tinyDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  /** A ~100KB data URL (simulating a real photo) */
  const largeDataUrl =
    'data:image/jpeg;base64,' + 'A'.repeat(136_000);

  it('should return 85 tokens for low detail', () => {
    const tokens = SmartTokenCounter.estimateImageTokens(tinyDataUrl, 'low');
    expect(tokens).toBe(85);
  });

  it('should return at least 85 tokens for high detail', () => {
    const tokens = SmartTokenCounter.estimateImageTokens(tinyDataUrl, 'high');
    expect(tokens).toBeGreaterThanOrEqual(85);
  });

  it('should return more tokens for larger images', () => {
    const small = SmartTokenCounter.estimateImageTokens(tinyDataUrl, 'auto');
    const large = SmartTokenCounter.estimateImageTokens(largeDataUrl, 'auto');
    expect(large).toBeGreaterThan(small);
  });

  it('should produce reasonable estimates (not astronomically large)', () => {
    const tokens = SmartTokenCounter.estimateImageTokens(largeDataUrl, 'high');
    // A ~100KB image should not cost more than ~12K tokens
    expect(tokens).toBeLessThan(12_000);
  });

  it('should handle auto detail the same as high detail', () => {
    const auto = SmartTokenCounter.estimateImageTokens(tinyDataUrl, 'auto');
    const high = SmartTokenCounter.estimateImageTokens(tinyDataUrl, 'high');
    expect(auto).toBe(high);
  });

  it('should handle undefined detail', () => {
    const tokens = SmartTokenCounter.estimateImageTokens(tinyDataUrl);
    // Should default to auto/high behavior
    expect(tokens).toBeGreaterThanOrEqual(85);
  });

  it('should handle empty base64 data gracefully', () => {
    const tokens = SmartTokenCounter.estimateImageTokens('data:image/png;base64,');
    expect(tokens).toBe(85); // minimum
  });

  it('should handle malformed data URL gracefully', () => {
    const tokens = SmartTokenCounter.estimateImageTokens('not-a-data-url');
    expect(tokens).toBe(85); // minimum
  });
});

describe('SmartTokenCounter.countContentTokens (image_url parts)', () => {
  const counter = new SmartTokenCounter();

  it('should count text parts correctly', () => {
    const tokens = counter.countContentTokens([{ type: 'text', text: 'hello world' }]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('should count image_url parts as image tokens', () => {
    const tokens = counter.countContentTokens([
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      },
    ]);
    // Should be at least the minimum 85 tokens
    expect(tokens).toBeGreaterThanOrEqual(85);
  });

  it('should count image_url with low detail as 85 tokens', () => {
    const tokens = counter.countContentTokens([
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          detail: 'low',
        } as { url: string; detail?: string },
      },
    ]);
    expect(tokens).toBe(85);
  });

  it('should sum text + image tokens', () => {
    const tokens = counter.countContentTokens([
      { type: 'text', text: 'Describe this image:' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      },
    ]);
    const textOnly = counter.countTokens('Describe this image:');
    // Total should be text + image (≥85)
    expect(tokens).toBeGreaterThan(textOnly + 84);
    expect(tokens).toBeLessThan(textOnly + 500);
  });
});
