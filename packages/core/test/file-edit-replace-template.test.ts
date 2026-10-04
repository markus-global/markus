/**
 * Regression: agent-authored replacement text must land VERBATIM.
 *
 * Bug (2026-10-04) — file_edit / apply_patch handed the replacement straight to
 * String.prototype.replace, which interprets dollar-sign sequences inside the
 * *replacement* as substitution patterns:
 *
 *   the matched text | everything before the match | everything after the match
 *   numbered capture groups | an escaped literal dollar sign
 *
 * The first three duplicate surrounding file content, so an edit silently
 * duplicated/expanded the file while the tool still reported success. Reported
 * symptom: a Chinese document grew by hundreds of lines and ended up holding two
 * copies of its own title. That was originally misdiagnosed as a CJK /
 * byte-offset problem — it was never about encoding; it was about the
 * replacement text containing a dollar-sign sequence (shell snippets, regex
 * examples, template fragments in docs are the common carriers).
 *
 * Fix: packages/core/src/tools/literal-replace.ts, shared by both tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceLiteral } from '../src/tools/literal-replace.js';
import { createFileEditTool } from '../src/tools/file.js';
import { createPatchTool } from '../src/tools/patch.js';
import type { SecurityGuard } from '../src/security.js';

/**
 * The five replacement patterns String.prototype.replace expands.
 * Note: with a *string* search there are no capture groups, so the group
 * pattern is the one case the old code happened to pass through unchanged;
 * it is asserted here to pin the documented behaviour, not as a discriminator.
 */
const DOLLAR_MATCHED = '$&';
const DOLLAR_PREFIX = '$`';
const DOLLAR_SUFFIX = "$'";
const DOLLAR_GROUP = '$1';
const DOLLAR_ESCAPE = '$$';
const ALL_DOLLAR_PATTERNS = [
  DOLLAR_MATCHED,
  DOLLAR_PREFIX,
  DOLLAR_SUFFIX,
  DOLLAR_GROUP,
  DOLLAR_ESCAPE,
];

const HEADER = '# 工具契约文档';
const TARGET = '替换目标';

function mockGuard(): SecurityGuard {
  return {
    validateFileReadPath: vi.fn(() => ({ allowed: true })),
    validateFilePath: vi.fn(() => ({ allowed: true })),
    validateShellCommand: vi.fn(() => ({ allowed: true })),
  } as unknown as SecurityGuard;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

/** A doc shaped like the one in the bug report: CJK body + a shell snippet. */
function docFixture(): string {
  return [
    HEADER,
    '',
    '## 1. 概述',
    '这是正文第一段。',
    '',
    '## 2. 用法',
    '```bash',
    "printf $'\\n'",
    '```',
    '',
    '## 3. 目标',
    TARGET,
    '',
    '## 4. 结尾',
    '收尾段落。',
    '',
  ].join('\n');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'markus-dollar-replace-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('replaceLiteral', () => {
  it('inserts every substitution pattern verbatim', () => {
    const content = 'HEAD\nTARGET\nTAIL\n';
    for (const pattern of ALL_DOLLAR_PATTERNS) {
      const replacement = `INSERT[${pattern}]`;
      expect(replaceLiteral(content, 'TARGET', replacement)).toBe(`HEAD\n${replacement}\nTAIL\n`);
    }
  });

  it('never duplicates the prefix or the suffix', () => {
    const content = 'HEAD\nTARGET\nTAIL\n';
    expect(replaceLiteral(content, 'TARGET', `P${DOLLAR_PREFIX}`)).toBe(`HEAD\nP${DOLLAR_PREFIX}\nTAIL\n`);
    expect(replaceLiteral(content, 'TARGET', `S${DOLLAR_SUFFIX}`)).toBe(`HEAD\nS${DOLLAR_SUFFIX}\nTAIL\n`);
  });

  it('replaces only the first occurrence, like String.prototype.replace', () => {
    expect(replaceLiteral('a a a', 'a', 'b')).toBe('b a a');
  });

  it('treats the search string literally, not as a pattern', () => {
    expect(replaceLiteral('x.y z', 'x.y', 'ok')).toBe('ok z');
  });
});

describe('file_edit — dollar-sign sequences in new_string', () => {
  it('inserts literally and leaves the document structurally intact', async () => {
    const original = docFixture();

    for (const pattern of ALL_DOLLAR_PATTERNS) {
      writeFileSync(join(dir, 'doc.md'), original, 'utf-8');
      const tool = createFileEditTool(mockGuard(), dir);

      const result = JSON.parse(await tool.execute({
        path: 'doc.md',
        old_string: TARGET,
        new_string: `新行 A${pattern}B`,
      }));
      expect(result.status).toBe('success');

      const after = readFileSync(join(dir, 'doc.md'), 'utf-8');
      // 1. the replacement landed verbatim
      expect(after).toContain(`新行 A${pattern}B`);
      // 2. no structural side effects: same line count, header exactly once
      expect(lineCount(after)).toBe(lineCount(original));
      expect(countOf(after, HEADER)).toBe(1);
      expect(countOf(after, TARGET)).toBe(0);
    }
  });

  it('reproduces the reported symptom: no duplicated header, no line inflation', async () => {
    // The target sits near the END, so the old prefix-duplication bug would have
    // re-emitted everything above it — that is how the reported doc gained
    // hundreds of lines while still reporting success.
    const body = Array.from({ length: 200 }, (_, i) => `正文第 ${i + 1} 行`);
    const original = [HEADER, '', ...body, '', TARGET, '', '结尾', ''].join('\n');

    writeFileSync(join(dir, 'big.md'), original, 'utf-8');
    const tool = createFileEditTool(mockGuard(), dir);
    const result = JSON.parse(await tool.execute({
      path: 'big.md',
      old_string: TARGET,
      new_string: `新行 ${DOLLAR_PREFIX}`,
    }));
    expect(result.status).toBe('success');

    const after = readFileSync(join(dir, 'big.md'), 'utf-8');
    expect(after).toContain(`新行 ${DOLLAR_PREFIX}`);
    expect(countOf(after, HEADER)).toBe(1);
    expect(lineCount(after)).toBe(lineCount(original));
  });

  it('still rejects a non-unique old_string', async () => {
    writeFileSync(join(dir, 'dup.md'), 'dup\ndup\n', 'utf-8');
    const tool = createFileEditTool(mockGuard(), dir);
    const result = JSON.parse(await tool.execute({
      path: 'dup.md',
      old_string: 'dup',
      new_string: `${DOLLAR_MATCHED}`,
    }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('found 2 times');
  });
});

describe('apply_patch — dollar-sign sequences in hunk new_string', () => {
  it('inserts every hunk literally, in sequence', async () => {
    const original = docFixture();
    const file = join(dir, 'doc.md');
    writeFileSync(file, original, 'utf-8');

    const tool = createPatchTool(undefined, dir);
    const result = JSON.parse(await tool.execute({
      patches: [{
        file: 'doc.md',
        action: 'edit',
        hunks: [
          { old_string: '这是正文第一段。', new_string: '改后第一段。' },
          { old_string: TARGET, new_string: `P=${DOLLAR_PREFIX} S=${DOLLAR_SUFFIX}` },
          { old_string: '收尾段落。', new_string: `M=${DOLLAR_MATCHED} D=${DOLLAR_ESCAPE}` },
        ],
      }],
    }));

    expect(result.status).toBe('success');
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('改后第一段。');
    expect(after).toContain(`P=${DOLLAR_PREFIX} S=${DOLLAR_SUFFIX}`);
    expect(after).toContain(`M=${DOLLAR_MATCHED} D=${DOLLAR_ESCAPE}`);
    expect(countOf(after, HEADER)).toBe(1);
    expect(lineCount(after)).toBe(lineCount(original));
  });

  it('keeps validation and apply passes consistent (dry_run stays clean)', async () => {
    const original = docFixture();
    const file = join(dir, 'dry.md');
    writeFileSync(file, original, 'utf-8');

    const tool = createPatchTool(undefined, dir);
    const result = JSON.parse(await tool.execute({
      patches: [{
        file: 'dry.md',
        action: 'edit',
        hunks: [{ old_string: TARGET, new_string: `PRE=${DOLLAR_PREFIX}` }],
      }],
      dry_run: true,
    }));

    expect(result.status).toBe('success');
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});
