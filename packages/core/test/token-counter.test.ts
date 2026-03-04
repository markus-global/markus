import { describe, it, expect } from 'vitest';
import { SmartTokenCounter, getDefaultTokenCounter, initTokenCounter } from '../src/token-counter.js';

describe('SmartTokenCounter', () => {
  it('should estimate tokens for English text', () => {
    const counter = new SmartTokenCounter();
    // ~4 chars/token for English
    const tokens = counter.countTokens('Hello, how are you doing today?');
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });

  it('should estimate more tokens per character for CJK text', () => {
    const counter = new SmartTokenCounter();
    const english = 'This is a test sentence with thirty characters';
    const chinese = '这是一个测试句子，包含大约三十个字符。这是一个测试句子，包含大约三十个字符';

    const enTokens = counter.countTokens(english);
    const cjkTokens = counter.countTokens(chinese);

    // CJK should produce more tokens per character
    const enRatio = english.length / enTokens;
    const cjkRatio = chinese.length / cjkTokens;
    expect(cjkRatio).toBeLessThan(enRatio);
  });

  it('should handle empty strings', () => {
    const counter = new SmartTokenCounter();
    expect(counter.countTokens('')).toBe(0);
  });

  it('should estimate message tokens with role overhead', () => {
    const counter = new SmartTokenCounter();
    const contentTokens = counter.countTokens('Hello');
    const messageTokens = counter.countMessageTokens('Hello', 'user');
    expect(messageTokens).toBeGreaterThan(contentTokens);
  });

  describe('calibration', () => {
    it('should adjust factor based on actual usage data', () => {
      const counter = new SmartTokenCounter();
      expect(counter.getCalibrationFactor()).toBe(1.0);

      // Simulate API returning 2x what we estimated
      for (let i = 0; i < 10; i++) {
        counter.calibrate(100, 200);
      }

      expect(counter.getCalibrationFactor()).toBeCloseTo(2.0, 1);
    });

    it('should clamp calibration factor to reasonable range', () => {
      const counter = new SmartTokenCounter();

      // Very high ratio should be clamped to 2.0
      for (let i = 0; i < 20; i++) {
        counter.calibrate(100, 1000);
      }
      expect(counter.getCalibrationFactor()).toBe(2.0);

      // Very low ratio should be clamped to 0.5
      const counter2 = new SmartTokenCounter();
      for (let i = 0; i < 20; i++) {
        counter2.calibrate(1000, 10);
      }
      expect(counter2.getCalibrationFactor()).toBe(0.5);
    });

    it('should keep only last 50 samples', () => {
      const counter = new SmartTokenCounter();
      for (let i = 0; i < 100; i++) {
        counter.calibrate(100, 150);
      }
      // Factor should still be reasonable
      expect(counter.getCalibrationFactor()).toBeCloseTo(1.5, 1);
    });

    it('should skip invalid calibration values', () => {
      const counter = new SmartTokenCounter();
      counter.calibrate(0, 100);
      counter.calibrate(100, 0);
      counter.calibrate(-5, 100);
      expect(counter.getCalibrationFactor()).toBe(1.0);
    });
  });

  describe('singleton', () => {
    it('should return a default counter', () => {
      const c1 = getDefaultTokenCounter();
      const c2 = getDefaultTokenCounter();
      expect(c1).toBe(c2);
    });

    it('should allow re-initialization', () => {
      const c1 = getDefaultTokenCounter();
      const c2 = initTokenCounter({ anthropicApiKey: 'test' });
      expect(c2).not.toBe(c1);
      expect(getDefaultTokenCounter()).toBe(c2);
    });
  });
});
