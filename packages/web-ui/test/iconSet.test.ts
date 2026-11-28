/**
 * 图标纪律（Owner 2026-11-28）：前端「图标槽」一律用自绘 SVG，不再用 emoji。
 *
 * 为什么：同一个 emoji 在 macOS / Windows / Linux 是四套画风、四种基线、四种尺寸，
 * 聊天里一排工具图标混着系统 emoji，跨平台必然「看着不是一套东西」。
 *
 * 这里钉三件事（任一条被破坏就红）：
 *   ① 图标集自洽：每个 IconName 都有 path，且 path 里没有 emoji；
 *   ② 已迁移的数据层不许回退：这些文件里不得再出现 `icon: '<emoji>'`；
 *   ③ **协议不能被“顺手统一”掉**：`CHIP_ICONS` 的 emoji 是 `[📄 a.md]` 这种草稿
 *      文本的序列化格式（写进输入框再被 parse 回来），必须保持 emoji；渲染侧走
 *      `CHIP_ICON_NAMES`。谁把两者合并成一份，这条就红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ICON_PATHS, type IconName } from '../src/components/Icon.tsx';
import { CHIP_ICONS, CHIP_ICON_NAMES, CHIP_KINDS } from '../src/lib/chatChips.ts';

/** 与审计脚本同口径：emoji 主要落在这些区段（不含普通标点/箭头）。 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

function read(rel: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');
}

/** 已迁移的图标数据层（新增迁移请往这里追加）。 */
const MIGRATED = [
  'src/components/execution-utils.ts',
  'src/components/ExecutionTimeline.tsx',
  'src/lib/mailboxTypeMeta.ts',
  'src/components/CodingToolCard.tsx',
  'src/components/DeliverableDetailModal.tsx',
  'src/components/DeliverableShareModal.tsx',
  'src/components/EntityCard.tsx',
  'src/components/FeedbackModal.tsx',
  'src/components/GrowthAmbassadorModal.tsx',
  'src/components/MarkdownComponents.tsx',
  'src/components/MarkdownMessage.tsx',
  'src/components/ModelRoutingSection.tsx',
  'src/components/OfficePreviewer.tsx',
  'src/components/Onboarding.tsx',
  'src/components/OrgAccountSection.tsx',
  'src/components/RemoteAccessSection.tsx',
  'src/components/TeamModals.tsx',
  'src/components/integrations/InstanceCard.tsx',
  'src/components/integrations/PlatformCard.tsx',
  'src/components/integrations/SetupGuide.tsx',
  'src/lib/agentOverview.ts',
  'src/pages/AgentBuilder.tsx',
  'src/pages/AgentProfile.tsx',
  'src/pages/CodingToolsSettings.tsx',
  'src/pages/SkillStore.tsx',
  'src/pages/StoreDiscovery.tsx',
  'src/pages/Team.tsx',
  'src/pages/TeamProfile.tsx',
  'src/pages/TeamsStore.tsx',
  'src/pages/Work.tsx',
  'src/pages/WebSearchSettings.tsx',
  'src/pages/teamPanels.tsx',
];

describe('图标集 Icon.tsx', () => {
  it('每个 IconName 都有 path，且 path 里没有 emoji', () => {
    const entries = Object.entries(ICON_PATHS) as Array<[IconName, string]>;
    expect(entries.length).toBeGreaterThan(40);
    for (const [name, d] of entries) {
      expect(d.length, `${name} 的 path 不能为空`).toBeGreaterThan(10);
      expect(EMOJI_RE.test(d), `${name} 的 path 里混进了 emoji`).toBe(false);
      expect(d, `${name} 应以 move 类指令开头`).toMatch(/^[Mm]/);
    }
  });
});

describe('数据层不许退回 emoji 图标', () => {
  it.each(MIGRATED)('%s 里没有 icon: "<emoji>"', rel => {
    const src = read(rel);
    const lines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const offenders = lines.filter(l => /icon:\s*['"][^'"]*['"]/.test(l) && EMOJI_RE.test(l));
    expect(offenders, `这些行还在用 emoji 当图标：\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('chip 的两份图标：文本协议 vs 渲染', () => {
  it('CHIP_ICONS 保持 emoji（[📄 a.md] 是序列化格式，不能被“统一”掉）', () => {
    for (const kind of CHIP_KINDS) {
      expect(EMOJI_RE.test(CHIP_ICONS[kind]) || CHIP_ICONS[kind] === '⌘', kind).toBe(true);
    }
  });

  it('CHIP_ICON_NAMES 全部是合法的 IconName', () => {
    for (const kind of CHIP_KINDS) {
      const name = CHIP_ICON_NAMES[kind];
      expect(ICON_PATHS[name], `${kind} → ${name} 不在图标集里`).toBeTruthy();
    }
  });
});
