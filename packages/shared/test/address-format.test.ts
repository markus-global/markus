/**
 * 第六刀 C1 第一片 —— 邮件地址标准 v1 的行为契约（A1–A4）。
 *
 * 这些断言是「会咬人」的行为测试，不是源码文本栅栏：
 * 任何一次实现改动只要放宽语法、把保留字开放给组织、或让外部地址
 * 伪装成内部身份，这里就会变红。
 *
 * 标准全文：markus-master-refactor-plan-2026-11-11.md §4.9
 * 口子清单：markus-cut6-mailbox-address-design-2026-11-10.md §2.8
 */
import { describe, it, expect } from 'vitest';
import {
  MARKUS_MAIL_DOMAIN,
  PLATFORM_RESERVED_ADDRESSES,
  formatAddress,
  parseAddress,
  isMarkusOrgAddress,
} from '../src/address.js';

const ok = (r: ReturnType<typeof parseAddress>) => {
  if (!r.ok) throw new Error(`expected ok, got reject: ${r.reason} / ${r.hint}`);
  return r.value;
};

describe('A1 — 格式语法：恰好一个点，非规范输入一律拒绝并给可行动提示', () => {
  it('规范形 round-trip：local.org@markus.global', () => {
    const built = ok(formatAddress('cto', 'acme'));
    expect(built.kind).toBe('markus');
    expect(built.address).toBe('cto.acme@markus.global');
    expect(built).toMatchObject({ local: 'cto', orgSlug: 'acme' });

    const parsed = ok(parseAddress(built.address));
    expect(parsed).toEqual(built);
  });

  it('点数即命名空间：0 点平台保留 / 1 点组织内 / ≥2 点留给团队级', () => {
    expect(ok(parseAddress('conduct@markus.global')).kind).toBe('platform');
    expect(ok(parseAddress('cto.acme@markus.global')).kind).toBe('markus');
    const two = parseAddress('cto.team.acme@markus.global');
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).toBe('team_level_reserved');
  });

  it.each([
    ['大写', 'CTO.acme@markus.global'],
    ['中文', '内容.acme@markus.global'],
    ['域名大写', 'cto.acme@MARKUS.GLOBAL'],
    ['子地址 +tag（v2 保留）', 'cto+tag.acme@markus.global'],
    ['首尾连字符', '-cto.acme@markus.global'],
    ['连续连字符', 'cto--x.acme@markus.global'],
    ['空 local', '.acme@markus.global'],
    ['空组织', 'cto.@markus.global'],
    ['超长 local', `${'a'.repeat(33)}.acme@markus.global`],
    ['超长组织', `cto.${'b'.repeat(31)}@markus.global`],
    ['下划线', 'cto_x.acme@markus.global'],
  ])('%s 被拒绝且带可行动提示', (_label, raw) => {
    const r = parseAddress(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hint.length).toBeGreaterThan(0);
      expect(r.hint).toContain('markus.global');
    }
  });

  it('formatAddress 与 parseAddress 共用同一套校验（不是两套规则）', () => {
    const viaFormat = formatAddress('CTO', 'acme');
    const viaParse = parseAddress('CTO.acme@markus.global');
    expect(viaFormat.ok).toBe(false);
    expect(viaParse.ok).toBe(false);
    if (!viaFormat.ok && !viaParse.ok) expect(viaFormat.reason).toBe(viaParse.reason);
  });
});

describe('A2 — 平台保留集是闭集，组织不得绑定', () => {
  it('已在线上使用的三个平台邮箱都在保留集里', () => {
    for (const name of ['conduct', 'business', 'security']) {
      expect(PLATFORM_RESERVED_ADDRESSES).toContain(name);
    }
  });

  it('0 点但不在保留集的地址被拒绝（不静默当组织地址）', () => {
    const r = parseAddress('randomperson@markus.global');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_platform_address');
  });

  it('平台保留地址不可作为组织内地址绑定', () => {
    for (const name of PLATFORM_RESERVED_ADDRESSES) {
      expect(isMarkusOrgAddress(`${name}@markus.global`)).toBe(false);
    }
  });

  it('保留字不得用作 local 或 org 段', () => {
    expect(formatAddress('admin', 'acme').ok).toBe(false);
    expect(formatAddress('cto', 'www').ok).toBe(false);
    expect(formatAddress('postmaster', 'acme').ok).toBe(false);
  });
});

describe('A3 — 全局唯一：跨组织不撞，同一完整地址恒等', () => {
  it('两个不同 org 下同名 local 得到不同完整地址', () => {
    const a = ok(formatAddress('cto', 'acme')).address;
    const b = ok(formatAddress('cto', 'globex')).address;
    expect(a).not.toBe(b);
    expect(ok(parseAddress(a)).orgSlug).toBe('acme');
    expect(ok(parseAddress(b)).orgSlug).toBe('globex');
  });

  it('同一地址解析两次恒等（可缓存：一种输入一种字节序列）', () => {
    const raw = 'cto.acme@markus.global';
    expect(parseAddress(raw)).toEqual(parseAddress(raw));
  });
});

describe('A4 — 人类邮箱隔离 / 外部地址不透明', () => {
  it('人类邮箱隔离守卫的判定谓词：组织格式 true，平台/外部 false', () => {
    expect(isMarkusOrgAddress('cto.acme@markus.global')).toBe(true);
    expect(isMarkusOrgAddress('conduct@markus.global')).toBe(false);
    expect(isMarkusOrgAddress('someone@gmail.com')).toBe(false);
  });

  it('外部地址原样保留为 opaque，绝不解析出 local / orgSlug', () => {
    const parsed = ok(parseAddress('someone@gmail.com'));
    expect(parsed.kind).toBe('external');
    expect(parsed.address).toBe('someone@gmail.com');
    expect('local' in parsed).toBe(false);
    expect('orgSlug' in parsed).toBe(false);
  });

  it('长得像内部地址的外部来信也不会被当成内部身份', () => {
    const parsed = ok(parseAddress('cto.acme@evil.example'));
    expect(parsed.kind).toBe('external');
    expect(isMarkusOrgAddress('cto.acme@evil.example')).toBe(false);
  });

  it('域名常量唯一', () => {
    expect(MARKUS_MAIL_DOMAIN).toBe('markus.global');
  });
});
