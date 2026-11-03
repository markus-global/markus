import { describe, it, expect } from 'vitest';
import {
  refKindLabel, shortRef, refDisplay, waitPhrase, wouldAcceptVerdict, STAGE_LABEL,
} from './threadPresentation.ts';

// ── 展示层原语 ────────────────────────────────────────────────────────────────
// 这组测试守的是两个页面「说人话」的能力。它存在的直接原因：
// 线上 Thread 视图里 `tsk_d0dd96f6b846b0c3e51b52f6` 铺在最显眼处、
// 一个「空闲」的流显示「已等 13 分钟」、而 observe 的「本可接单」提示
// 因为判据写反（=== false）**从来没有显示过**。
// 语义反了不会报错，只会安静地少显示东西 —— 所以必须由测试钉住。

describe('refKindLabel — 机器前缀翻译成人话', () => {
  it('平台内置 id 有明确种类', () => {
    expect(refKindLabel('tsk_abc')).toBe('任务');
    expect(refKindLabel('req_abc')).toBe('需求');
    expect(refKindLabel('cs_abc')).toBe('会话');
    expect(refKindLabel('a2a_x__y')).toBe('Agent 对话');
    expect(refKindLabel('thr_abc')).toBe('流');
  });

  it('外部资源键取前缀作来源名', () => {
    expect(refKindLabel('gh:acme/repo')).toBe('gh');
    expect(refKindLabel('xhs:brand_01')).toBe('xhs');
  });

  it('空值不抛错，回退成「流」', () => {
    expect(refKindLabel(null)).toBe('流');
    expect(refKindLabel(undefined)).toBe('流');
    expect(refKindLabel('')).toBe('流');
  });
});

describe('shortRef — 只截对人无意义的机器 id', () => {
  it('长 id 截成前缀 + 6 位（仍可用于排障定位）', () => {
    expect(shortRef('tsk_d0dd96f6b846b0c3e51b52f6')).toBe('tsk_d0dd96');
    expect(shortRef('cs_1b4bab83e4e7431d')).toBe('cs_1b4bab');
  });

  it('外部资源键原样返回 —— 它本身可读，截断反而伤信息', () => {
    expect(shortRef('gh:acme/widgets')).toBe('gh:acme/widgets');
    expect(shortRef('xhs:brand_01')).toBe('xhs:brand_01');
  });

  it('短 id 不硬截（本来就没超长）', () => {
    expect(shortRef('tsk_abc')).toBe('tsk_abc');
  });
});

describe('refDisplay — 「这是什么 · 定位符」', () => {
  it('内置 id 带上种类，人一眼知道是任务还是会话', () => {
    expect(refDisplay('tsk_d0dd96f6b846b0c3e51b52f6')).toBe('任务 · tsk_d0dd96');
  });

  it('外部键不重复类型（gh · gh:acme 是废话）', () => {
    expect(refDisplay('gh:acme/widgets')).toBe('gh:acme/widgets');
  });
});

describe('waitPhrase — 时间短语按 stage 变（修「空闲却说已等」）', () => {
  const ms = 13 * 60_000;

  it('在等人的流才说「已等」', () => {
    for (const s of ['person:approval', 'person:answer', 'person:review', 'person:blocked']) {
      expect(waitPhrase(s, ms), s).toBe('已等 13 分钟');
    }
  });

  it('空闲的流不能说「已等」—— 没有人在等', () => {
    // 这条是核心：曾经所有 stage 共用「已等」，读者会去找它在等谁，而答案是没人。
    expect(waitPhrase('idle', ms)).toBe('最后活动 13 分钟前');
    expect(waitPhrase('idle', ms)).not.toContain('已等');
  });

  it('进行中/排队各有自己的说法', () => {
    expect(waitPhrase('working', ms)).toBe('已进行 13 分钟');
    expect(waitPhrase('system:queued', ms)).toBe('排队 13 分钟');
  });

  it('未知 stage 不抛错，退到中性说法', () => {
    expect(waitPhrase(null, ms)).toBe('最后活动 13 分钟前');
    expect(waitPhrase('some:new-stage', ms)).toBe('最后活动 13 分钟前');
  });
});

describe('wouldAcceptVerdict — 语义唯一判据（判据写反过两次，且被当布尔用过一次）', () => {
  it('true = 本可接单（放行的话他会接）', () => {
    expect(wouldAcceptVerdict({ wouldAccept: true })).toBe('accept');
    // 关键反例：曾经两处 UI 都写成 `=== false`，于是 observe 记录
    // 永远进不了「观察模式」筛选、提示也永远不显示。
    expect(wouldAcceptVerdict({ wouldAccept: false })).toBe('reject');
  });

  it('缺失/null 是「没问过」—— 不是「不会接」', () => {
    // B3（2026-11-03）：这三态曾经被压成布尔，dispatch/attach/stop 的处置
    // 被读成 false，UI 于是对着「没问过」的行说「当时判定不该来」。
    expect(wouldAcceptVerdict({})).toBe('not-asked');
    expect(wouldAcceptVerdict({ wouldAccept: null })).toBe('not-asked');
    expect(wouldAcceptVerdict({ wouldAccept: undefined })).toBe('not-asked');
  });
});

describe('STAGE_LABEL — 七个 stage 一个不少（展示层不得因新 stage 白屏）', () => {
  it('闭集完整', () => {
    expect(Object.keys(STAGE_LABEL).sort()).toEqual([
      'idle', 'person:answer', 'person:approval', 'person:blocked',
      'person:review', 'system:queued', 'working',
    ]);
  });
});
