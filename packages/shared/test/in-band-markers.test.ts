/**
 * in-band 标记登记表（L0）的契约测试。
 *
 * 这里守三件事，任何一件破了都意味着「载荷字段又变成纯约定了」：
 *  1. **登记项完整**：每个标记都有 名称 / 语义 / 唯一谓词 / 唯一写者，且写者文件真的存在；
 *  2. **判定唯一**：`packages/*\/src` 里不得再有第二处 `extra.<marker>` 字面比较
 *     （所有读取点必须走 `isInBandMarkerSet()`）；
 *  3. **未登记即拒绝**：写侧/读侧遇到未登记的布尔标记都抛可行动错误，而不是放行或忽略。
 *
 * 第 2 条是静态源码扫描（不是行为测试）——「没有第二处判定」这件事只能这样证。
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IN_BAND_MARKERS,
  UnregisteredInBandMarkerError,
  assertInBandMarkersDeclared,
  inBandMarkerJsonPath,
  isInBandMarkerSet,
  registeredInBandMarkers,
  unregisteredInBandMarkerKeys,
  type InBandMarkerName,
} from '../src/types/in-band-markers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REGISTRY_FILE = 'packages/shared/src/types/in-band-markers.ts';

/** 这台机器上的行为标记（本卡要求登记的三件套）。 */
const BEHAVIOR_MARKERS: InBandMarkerName[] = ['actionRequired', 'triggerExecution', 'directMention'];

/**
 * 去掉注释后再扫描。
 *
 * 注释里写 `payload.extra.actionRequired = 1` 是**文档**，不是判定点；
 * 但注释掉的代码同样是死判定（不该复活），所以扫描口径是「去掉注释后的真实代码」。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** `packages/*\/src/**\/*.ts`（排除登记表本身）—— 被测的生产源码面。 */
function sourceFiles(): string[] {
  const files: string[] = [];
  const packagesDir = join(ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    walk(srcDir, files);
  }
  return files.filter(f => relative(ROOT, f) !== REGISTRY_FILE);
}

describe('1 · 登记表完整性（L0 单一事实源）', () => {
  it('三个行为标记全部登记为 marker（actionRequired / triggerExecution / directMention）', () => {
    for (const name of BEHAVIOR_MARKERS) {
      const spec = IN_BAND_MARKERS[name];
      expect(spec, `${name} must be registered`).toBeTruthy();
      expect(spec.kind).toBe('marker');
      expect(spec.key).toBe(name);
    }
  });

  it('每个登记项都带语义 + 唯一谓词 + 非空写者清单', () => {
    for (const [name, spec] of Object.entries(IN_BAND_MARKERS)) {
      expect(spec.key, name).toBe(name);
      expect(['marker', 'flag']).toContain(spec.kind);
      // 语义必须是人能读懂的一句话，不是占位符。
      expect(spec.meaning.length, `${name}: meaning too short`).toBeGreaterThan(20);
      expect(typeof spec.read, `${name}: read predicate`).toBe('function');
      expect(spec.writers.length, `${name}: writers must be listed`).toBeGreaterThan(0);
    }
  });

  it('写者清单里的文件真的存在（清单不许腐烂）', () => {
    for (const [name, spec] of Object.entries(IN_BAND_MARKERS)) {
      for (const writer of spec.writers) {
        expect(existsSync(join(ROOT, writer)), `${name}: declared writer ${writer} does not exist`).toBe(true);
      }
    }
  });

  it('谓词是唯一判定：真值只认 `=== true`，脏值不算置真', () => {
    for (const name of BEHAVIOR_MARKERS) {
      expect(isInBandMarkerSet({ payload: { extra: { [name]: true } } }, name)).toBe(true);
      expect(isInBandMarkerSet({ payload: { extra: { [name]: false } } }, name)).toBe(false);
      expect(isInBandMarkerSet({ payload: { extra: { [name]: 'yes' } } }, name)).toBe(false);
      expect(isInBandMarkerSet({ payload: { extra: {} } }, name)).toBe(false);
      expect(isInBandMarkerSet({ payload: {} }, name)).toBe(false);
      expect(isInBandMarkerSet({}, name)).toBe(false);
    }
  });

  it('持久层 JSON 路径从登记表派生（SQL 里不再手写标记字面量）', () => {
    for (const name of BEHAVIOR_MARKERS) {
      expect(inBandMarkerJsonPath(name)).toBe(`$.extra.${name}`);
    }
  });
});

describe('2 · 未登记即拒绝（fail-closed，写侧与读侧同一判据）', () => {
  it('未登记的布尔标记：写侧拒绝，并给出可行动错误', () => {
    const payload = { summary: 's', content: 'c', extra: { newSchedulingHint: true } };

    expect(() => assertInBandMarkersDeclared({ payload }, 'write')).toThrow(UnregisteredInBandMarkerError);

    let message = '';
    try {
      assertInBandMarkersDeclared({ payload }, 'write');
    } catch (err) {
      message = String((err as Error).message);
    }
    // 可行动：指明登记表位置 + 已登记清单 + 标记的定义。
    expect(message).toContain('in-band-markers.ts');
    expect(message).toContain('IN_BAND_MARKERS');
    expect(message).toContain('actionRequired');
    expect(message).toContain('newSchedulingHint');
    expect(message).toMatch(/non-boolean extra keys are data/);
  });

  it('未登记的布尔标记：读侧同样拒绝（不是静默当成流水账）', () => {
    expect(() =>
      assertInBandMarkersDeclared({ payload: { extra: { newSchedulingHint: true } } }, 'read'),
    ).toThrow(/Refusing to interpret/);
  });

  it('非布尔键不受管辖（数据字段不需要登记）', () => {
    const payload = {
      extra: {
        event: 'step_failed',
        factFingerprint: 'a->b',
        round: 3,
        mentions: ['agt_1'],
        sessionHint: { kind: 'system' },
        images: ['a.png'],
        missing: ['out1'],
      },
    };
    expect(() => assertInBandMarkersDeclared({ payload }, 'write')).not.toThrow();
    expect(unregisteredInBandMarkerKeys(payload.extra)).toEqual([]);
  });

  it('已登记但值不是布尔：拒绝（truthy 与 `=== true` 会得出相反结论）', () => {
    expect(() =>
      assertInBandMarkersDeclared({ payload: { extra: { actionRequired: 'yes' } } }, 'write'),
    ).toThrow(/must be a boolean or undefined/);
  });

  it('已登记标记写 undefined 不算违规（JSON 序列化也会丢掉它）', () => {
    expect(() =>
      assertInBandMarkersDeclared({ payload: { extra: { directMention: undefined, triggerExecution: false } } }, 'write'),
    ).not.toThrow();
  });

  it('已登记标记正常通过', () => {
    expect(() =>
      assertInBandMarkersDeclared(
        { payload: { extra: { actionRequired: true, triggerExecution: true, directMention: true } } },
        'write',
      ),
    ).not.toThrow();
  });

  it('读取未登记的名字也必须报错（读侧不许「猜」一个标记）', () => {
    expect(() => isInBandMarkerSet({ payload: {} }, 'notAMarker' as InBandMarkerName)).toThrow(
      UnregisteredInBandMarkerError,
    );
  });

  it('错误里列出的已登记名字与登记表一致', () => {
    expect(registeredInBandMarkers().sort()).toEqual(Object.keys(IN_BAND_MARKERS).sort());
  });
});

describe('3 · 没有第二处判定（源码扫描）', () => {
  it('`packages/*/src` 里不得再出现 `extra.<marker>` 形式的字面读取', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50); // 扫描真的有内容，别空转绿

    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const name of BEHAVIOR_MARKERS) {
        const patterns = [
          new RegExp(`\\bextra\\s*\\?\\.\\s*${name}\\b`),
          new RegExp(`\\bextra\\s*\\.\\s*${name}\\b`),
          new RegExp(`\\bextra\\s*\\?*\\.?\\s*\\[\\s*['"\`]${name}['"\`]\\s*\\]`),
        ];
        if (patterns.some(p => p.test(code))) {
          offenders.push(`${relative(ROOT, file)}: reads extra.${name} inline`);
        }
      }
    }

    // 有违规就说明「同一契约两处实现」又长出来了 —— 改成 isInBandMarkerSet(item, name)。
    expect(offenders).toEqual([]);
  });

  it('每个行为标记只由登记表声明的写者写（单写者清单不许腐烂）', () => {
    const files = sourceFiles();

    for (const name of BEHAVIOR_MARKERS) {
      const declared = new Set(IN_BAND_MARKERS[name].writers.map(w => w));
      const actual = files
        .filter(file => {
          const code = stripComments(readFileSync(file, 'utf8'));
          // 写者形态：`<marker>: <value>` 出现在 extra 对象字面量里。
          return new RegExp(`\\b${name}\\s*:`).test(code);
        })
        .map(file => relative(ROOT, file));

      expect(actual.sort(), `undeclared writer of extra.${name}`).toEqual(
        [...declared].sort(),
      );
    }
  });
});
