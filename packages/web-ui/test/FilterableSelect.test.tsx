/**
 * FilterableSelect 回归护栏 —— 设置页「测试用模型」下拉。
 *
 * 这个组件替换的是一个原生 <select>：provider 的模型 id 又长又多（例如
 * `claude-sonnet-4-5-20250929`），只能滚列表等于没有选择体验。这里的断言把
 * 几条容易回归的交互钉死：
 *
 *   - 面板挂在 document.body（portal）。这条是**裁剪回归**的护栏：provider 卡片
 *     是 `rounded-xl overflow-hidden`，改回内联 absolute 定位会被卡片边缘切掉；
 *   - 输入即过滤，且「未编辑时预填的当前值不算查询词」——否则打开后列表只剩 1 项；
 *   - 多词 AND 匹配（`sonnet 4` 命中 claude-sonnet-4-5）；前缀命中排更前；
 *   - ↑/↓ + Enter 选中；点击（mousedown）即在失焦前选中；
 *   - Escape / 点击外部 = 放弃半截输入并还原显示值，绝不把输入残文当值提交；
 *   - 空值行（"使用默认模型"）始终可选，能撤回默认；
 *   - 给了 customHint 时，未命中任何选项的输入可作为自由值提交。
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterableSelect } from '../src/components/FilterableSelect.tsx';

const MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'gpt-4o-mini',
  'gemini-2.5-pro',
];

/**
 * 受控外壳：Setting.tsx 里 value 由父组件持有，选中后立刻回写。测试必须复现这一点，
 * 否则「选中后输入框显示新模型名」这类断言会假失败（组件本身是被控的）。
 */
function Harness({
  initial = '',
  onChange,
  ...rest
}: Partial<React.ComponentProps<typeof FilterableSelect>> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <FilterableSelect
      options={MODELS}
      placeholder="（使用默认模型）"
      filterPlaceholder="筛选模型…"
      emptyText="无匹配模型"
      ariaLabel="测试用模型"
      {...rest}
      value={value}
      onChange={nv => { onChange?.(nv); setValue(nv); }}
    />
  );
}

function setup(props: Partial<React.ComponentProps<typeof FilterableSelect>> & { initial?: string } = {}) {
  const onChange = vi.fn();
  const utils = render(<Harness onChange={onChange} {...props} />);
  return { onChange, ...utils };
}

const field = () => screen.getByRole('combobox', { name: '测试用模型' }) as HTMLInputElement;
const listbox = () => screen.queryByRole('listbox');
const optionLabels = () =>
  screen.queryAllByRole('option').map(o => o.querySelector('span')?.textContent ?? '');

describe('FilterableSelect', () => {
  it('关闭时显示选中项的标签，未选中时显示占位文案', () => {
    const { unmount } = setup({ initial: 'gpt-4o-mini' });
    expect(field().value).toBe('gpt-4o-mini');
    unmount();

    setup();
    expect(field().value).toBe('（使用默认模型）');
    expect(listbox()).toBeNull();
  });

  it('面板挂在 document.body 上（避免被 overflow-hidden 卡片裁掉）', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(field());
    const menu = listbox();
    expect(menu).not.toBeNull();
    expect(menu!.parentElement).toBe(document.body);
  });

  it('打开时列出全部模型，且预填的当前值不被当成查询词', async () => {
    const user = userEvent.setup();
    setup({ initial: 'gpt-4o-mini' });
    await user.click(field());

    expect(listbox()).not.toBeNull();
    // 空值行 + 4 个模型全在；若把预填值当查询词，这里会只剩 1 项
    expect(optionLabels()).toEqual(['（使用默认模型）', ...MODELS]);
  });

  it('输入即过滤（大小写不敏感），无匹配时显示空状态', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(field());
    await user.keyboard('GEMINI');

    expect(optionLabels()).toEqual(['gemini-2.5-pro']);

    await user.keyboard('zzz');
    expect(optionLabels()).toEqual([]);
    expect(screen.getByText('无匹配模型')).toBeInTheDocument();
  });

  it('多词 AND 匹配，前缀命中排在前面', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(field());

    await user.keyboard('sonnet 4');
    expect(optionLabels()).toEqual(['claude-sonnet-4-5-20250929']);

    await user.clear(field());
    await user.keyboard('claude');
    expect(optionLabels().slice(0, 2)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
    ]);
  });

  it('↑/↓ 移动高亮，Enter 选中', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(field());
    await user.keyboard('gemini');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('gemini-2.5-pro');
    expect(listbox()).toBeNull();
    expect(field().value).toBe('gemini-2.5-pro');
  });

  it('打开时高亮当前选中项，↓ 移到下一项并选中', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ initial: 'gpt-4o-mini' });
    await user.click(field());
    await user.keyboard('{ArrowDown}{Enter}');

    // 打开时高亮「当前值」，↓ 走到列表里的下一项（gpt-4o-mini → gemini-2.5-pro）
    expect(onChange).toHaveBeenCalledWith('gemini-2.5-pro');
  });

  it('空值行可被过滤、可选中 —— 能撤回「使用默认模型」', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ initial: 'gpt-4o-mini' });
    await user.click(field());
    await user.keyboard('默认');

    expect(optionLabels()).toEqual(['（使用默认模型）']);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('');
    expect(field().value).toBe('（使用默认模型）');
  });

  it('点击选项即选中（在失焦之前）', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.click(field());
    await user.click(screen.getByRole('option', { name: 'gpt-4o-mini' }));

    expect(onChange).toHaveBeenCalledWith('gpt-4o-mini');
    expect(listbox()).toBeNull();
  });

  it('Escape 关闭并丢弃半截输入，不提交任何值', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ initial: 'gpt-4o-mini' });
    await user.click(field());
    await user.keyboard('gem');
    await user.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).toBeNull();
    expect(field().value).toBe('gpt-4o-mini');
  });

  it('点击组件外部关闭，同样不提交', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    render(<button type="button">外面</button>);
    await user.click(field());
    await user.keyboard('gem');
    await user.click(screen.getByRole('button', { name: '外面' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(listbox()).toBeNull();
  });

  it('点击面板本身不会关闭（portal 里的点击算“内部”）', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(field());
    await user.click(listbox()!);
    expect(listbox()).not.toBeNull();
  });

  it('customHint 给出时，未命中任何选项的输入可作为自由值提交', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ customHint: () => '使用输入的值' });
    await user.click(field());
    await user.keyboard('my-local-model');

    const custom = screen.getByRole('option', { name: /my-local-model/ });
    await user.click(custom);
    expect(onChange).toHaveBeenCalledWith('my-local-model');
  });

  it('没有 customHint 时不会凭空造出自由值行', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(field());
    await user.keyboard('my-local-model');
    expect(optionLabels()).toEqual([]);
  });

  it('无障碍属性跟随展开状态', async () => {
    const user = userEvent.setup();
    setup();
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    await user.click(field());
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(field()).toHaveAttribute('aria-autocomplete', 'list');
  });

  it('disabled 时点开无效', async () => {
    const user = userEvent.setup();
    setup({ disabled: true });
    await user.click(field());
    expect(listbox()).toBeNull();
  });
});
