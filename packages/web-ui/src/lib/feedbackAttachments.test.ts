import { describe, it, expect } from 'vitest';
import {
  MAX_FEEDBACK_IMAGES,
  MAX_FEEDBACK_IMAGE_BYTES,
  acceptFeedbackFiles,
  formatBytes,
  validateFeedbackDraft,
} from './feedbackAttachments.ts';

function file(name: string, size = 1024, type = 'image/png') {
  return { name, size, type };
}

describe('acceptFeedbackFiles', () => {
  it('accepts supported images within limits', () => {
    const { accepted, rejected } = acceptFeedbackFiles(
      [file('a.png'), file('b.jpg', 2048, 'image/jpeg'), file('c.webp', 4096, 'image/webp')],
      0,
    );
    expect(accepted.map(f => f.name)).toEqual(['a.png', 'b.jpg', 'c.webp']);
    expect(rejected).toEqual([]);
  });

  it('rejects non-image types and oversize files with distinct reasons', () => {
    const { accepted, rejected } = acceptFeedbackFiles(
      [file('notes.pdf', 1024, 'application/pdf'), file('huge.png', MAX_FEEDBACK_IMAGE_BYTES + 1)],
      0,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: 'notes.pdf', reason: 'not_image' },
      { name: 'huge.png', reason: 'too_large' },
    ]);
  });

  it('caps the total at MAX_FEEDBACK_IMAGES and reports the overflow', () => {
    const candidates = Array.from({ length: MAX_FEEDBACK_IMAGES + 2 }, (_, i) => file(`shot-${i}.png`));
    const { accepted, rejected } = acceptFeedbackFiles(candidates, 0);
    expect(accepted).toHaveLength(MAX_FEEDBACK_IMAGES);
    expect(rejected.map(r => r.reason)).toEqual(['too_many', 'too_many']);
  });

  it('respects files already attached', () => {
    const { accepted, rejected } = acceptFeedbackFiles([file('extra.png')], MAX_FEEDBACK_IMAGES);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ name: 'extra.png', reason: 'too_many' }]);
  });

  it('accepts exactly 5MB (boundary is inclusive)', () => {
    const { accepted } = acceptFeedbackFiles([file('edge.png', MAX_FEEDBACK_IMAGE_BYTES)], 0);
    expect(accepted).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('renders human readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(MAX_FEEDBACK_IMAGE_BYTES)).toBe('5 MB');
  });
});

describe('validateFeedbackDraft', () => {
  it('requires a non-blank title', () => {
    expect(validateFeedbackDraft({ title: '' })).toBe('title_required');
    expect(validateFeedbackDraft({ title: '   ' })).toBe('title_required');
    expect(validateFeedbackDraft({ title: '崩溃了' })).toBeNull();
  });
});
