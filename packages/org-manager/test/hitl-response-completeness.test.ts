/**
 * 「同意」不等于「回答」（2026-10-28 事故回归）。
 *
 * 事故：选项写着「直接给你数字」，还要求填 `Agent / Team / Project` 三个数。
 * 老板在**飞书卡片**上点了同意 —— 那个渠道收不到文字；agent 于是收到一个
 * 没有数字的「批准」，只能自己按默认值执行（「Free 层数量对外永久不写」）。
 * 决策被渠道的表达能力悄悄改写了，而它以为那是老板的意思。
 *
 * 锁的不变量：选项声明了 `requiresFreeform`，则**没有配套文字就不构成回答**；
 * 服务端拒绝它、审批保持 pending，人类可以补上再交。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HITLService, assessResponseCompleteness, isAnswerableByTap, answersFromTap } from '../src/hitl-service.js';

function requestFreeformChoice(service: HITLService, opts?: { requiresFreeform?: boolean }) {
  return service.requestApproval({
    agentId: 'agt_test',
    agentName: 'GEO策略主管',
    type: 'custom',
    title: 'Free 层数量上限：给我数字，或回「不公示」',
    description: '公开源查不到，需要你拍一个口径。',
    options: [
      {
        id: 'give_numbers',
        label: '直接给你数字',
        ...(opts?.requiresFreeform === false ? {} : { requiresFreeform: true }),
      },
      { id: 'no_publish', label: '不公示' },
    ],
  });
}

describe('assessResponseCompleteness — 单一判定点', () => {
  const approval = {
    options: [
      { id: 'give_numbers', label: '给你数字', requiresFreeform: true },
      { id: 'no_publish', label: '不公示' },
    ],
  };

  it('选了需要补充输入的选项但没给文字 → 不完整', () => {
    const verdict = assessResponseCompleteness(approval, 'give_numbers');
    expect(verdict?.incomplete).toBe(true);
    expect(verdict?.missing).toContain('option:give_numbers');
  });

  it('空白的 comment 不算文字', () => {
    expect(assessResponseCompleteness(approval, 'give_numbers', '   ')?.incomplete).toBe(true);
  });

  it('给了文字 → 构成回答', () => {
    expect(assessResponseCompleteness(approval, 'give_numbers', '3 / 1 / 1')).toBeUndefined();
  });

  it('普通选项本来就不需要文字', () => {
    expect(assessResponseCompleteness(approval, 'no_publish')).toBeUndefined();
  });

  it('answers[].text 也算文字；问题级选项同样受约束', () => {
    const withQuestion = {
      questions: [
        {
          id: 'free_quota',
          prompt: '多少？',
          inputType: 'choice' as const,
          options: [{ id: 'give_numbers', label: '给你数字', requiresFreeform: true }],
          allowMultiple: false,
          allowFreeform: true,
        },
      ],
    };
    expect(
      assessResponseCompleteness(withQuestion, undefined, undefined, [
        { questionId: 'free_quota', selectedOptionIds: ['give_numbers'] },
      ])?.missing,
    ).toContain('question:free_quota:option:give_numbers:text');

    expect(
      assessResponseCompleteness(withQuestion, undefined, undefined, [
        { questionId: 'free_quota', selectedOptionIds: ['give_numbers'], text: '3 / 1 / 1' },
      ]),
    ).toBeUndefined();
  });
});

describe('isAnswerableByTap — 一次点击能不能答完（渠道发不发按钮的唯一判据）', () => {
  const selfContained = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];

  it('纯审批（无问题无选项）→ 同意/拒绝就是问题', () => {
    expect(isAnswerableByTap(undefined, undefined)).toBe(true);
  });

  it('恰好一个单选 choice、选项自带完整含义 → 可以', () => {
    expect(isAnswerableByTap([
      { id: 'q1', prompt: '选哪个？', inputType: 'choice', options: selfContained, allowMultiple: false },
    ])).toBe(true);
  });

  it('选项需要补字 → 不可以（点下去不是答案）', () => {
    expect(isAnswerableByTap([
      { id: 'q1', prompt: 'q', inputType: 'choice', allowMultiple: false,
        options: [{ id: 'n', label: '给你数字', requiresFreeform: true }] },
    ])).toBe(false);
  });

  it('多个问题 → 不可以（一张表单按一次按钮批不了）', () => {
    expect(isAnswerableByTap([
      { id: 'q1', prompt: 'q1', inputType: 'choice', options: selfContained, allowMultiple: false },
      { id: 'q2', prompt: 'q2', inputType: 'text' },
    ])).toBe(false);
  });

  it('多选 / 文本题 → 不可以', () => {
    expect(isAnswerableByTap([
      { id: 'q1', prompt: 'q', inputType: 'choice', options: selfContained, allowMultiple: true },
    ])).toBe(false);
    expect(isAnswerableByTap([{ id: 'q1', prompt: 'q', inputType: 'text' }])).toBe(false);
  });
});

describe('多问题表单：每个问题都要被回答（不能只答一个就交卷）', () => {
  const form = {
    questions: [
      {
        id: 'q1',
        prompt: 'Free 层 Agent 上限？',
        inputType: 'choice' as const,
        options: [
          { id: 'give', label: '给你数字', requiresFreeform: true },
          { id: 'unknown', label: '不公示' },
        ],
        allowMultiple: false,
        allowFreeform: true,
      },
      { id: 'q2', prompt: 'Team 上限？', inputType: 'text' as const },
    ],
  };

  it('只回答了第一问 → 不完整，并指出缺哪一问', () => {
    const verdict = assessResponseCompleteness(form, undefined, undefined, [
      { questionId: 'q1', selectedOptionIds: ['unknown'] },
    ]);
    expect(verdict?.missing).toContain('question:q2:text');
  });

  it('第一问选了「给你数字」但没填数字 → 不完整（即使第二问答了）', () => {
    const verdict = assessResponseCompleteness(form, undefined, undefined, [
      { questionId: 'q1', selectedOptionIds: ['give'] },
      { questionId: 'q2', text: '1' },
    ]);
    expect(verdict?.missing).toContain('question:q1:option:give:text');
    // 第二问的文字不能替第一问交差
    expect(verdict?.missing).not.toContain('question:q2:text');
  });

  it('两问都齐了 → 构成回答', () => {
    expect(assessResponseCompleteness(form, undefined, undefined, [
      { questionId: 'q1', selectedOptionIds: ['give'], text: '3' },
      { questionId: 'q2', text: '1' },
    ])).toBeUndefined();
  });

  it('服务端拒绝只答一半的表单，审批保持 pending', () => {
    const service = new HITLService();
    const approval = service.requestApproval({
      agentId: 'agt_test',
      agentName: 'GEO策略主管',
      type: 'custom',
      title: 'Free 层三个上限',
      description: '需要三个数字',
      questions: form.questions,
    }) as { id: string };

    const refused = service.respondToApproval(approval.id, true, 'owner-1', undefined, undefined, [
      { questionId: 'q1', selectedOptionIds: ['unknown'] },
    ]);
    expect(refused).toBeUndefined();
    expect(service.getApproval(approval.id)?.status).toBe('pending');

    const accepted = service.respondToApproval(approval.id, true, 'owner-1', undefined, undefined, [
      { questionId: 'q1', selectedOptionIds: ['give'], text: '3' },
      { questionId: 'q2', text: '1' },
    ]);
    expect(accepted).toBeTruthy();
  });
});

describe('卡片点击与表单是同一份答案的两个形状（2026-10-28 实测回归）', () => {
  const tappable = {
    questions: [
      {
        id: 'card_choices',
        prompt: '你看到的是哪一组？',
        inputType: 'choice' as const,
        options: [
          { id: 'my_options', label: '看到我给的选项' },
          { id: 'approve_reject', label: '只有同意/拒绝' },
        ],
        allowMultiple: false,
        allowFreeform: true,
      },
    ],
  };

  it('answersFromTap 把点击归一成该问题的答案', () => {
    expect(answersFromTap(tappable, 'my_options')).toEqual([
      { questionId: 'card_choices', selectedOptionIds: ['my_options'] },
    ]);
  });

  it('渠道合成的 approve/reject 不属于题目的选项 → 不归一', () => {
    expect(answersFromTap(tappable, 'approve')).toBeUndefined();
  });

  it('多问题表单本就不可能被一次点击答完 → 不归一', () => {
    expect(
      answersFromTap(
        { questions: [...tappable.questions, { id: 'q2', prompt: 'q2', inputType: 'text' as const }] },
        'my_options',
      ),
    ).toBeUndefined();
  });

  it('飞书卡片点击（只有 selectedOption，没有 answers）现在能被记录', () => {
    const service = new HITLService();
    const approval = service.requestApproval({
      agentId: 'agt_test',
      agentName: 'CTO',
      type: 'custom',
      title: '（联调 2/3）单问题',
      description: '见卡片选项',
      questions: tappable.questions,
    }) as { id: string };

    // 这就是 start.ts 里卡片 tap 的调用形状：comment 为 undefined。
    const resolved = service.respondToApproval(approval.id, true, 'ou_tapper', undefined, 'my_options');
    expect(resolved, '可点击的问题必须能被点击回答').toBeTruthy();
    const recorded = service.getApproval(approval.id);
    expect(recorded?.status).not.toBe('pending');
    expect(recorded?.answers?.[0]?.selectedOptionIds).toEqual(['my_options']);
  });
});

describe('respondToApproval 拒绝不完整的回答（写者侧兜底）', () => {
  let service: HITLService;

  beforeEach(() => {
    service = new HITLService();
  });

  it('缺文字时不记录决策，审批保持 pending', () => {
    const approval = requestFreeformChoice(service) as { id: string };

    const refused = service.respondToApproval(approval.id, true, 'owner-1', undefined, 'give_numbers');
    expect(refused, '不完整的回答必须被拒绝').toBeUndefined();
    expect(service.getApproval(approval.id)?.status, '审批必须还能被重新回答').toBe('pending');
  });

  it('补上文字后同一次回答被接受', () => {
    const approval = requestFreeformChoice(service) as { id: string };

    const accepted = service.respondToApproval(approval.id, true, 'owner-1', '3 / 1 / 1', 'give_numbers');
    expect(accepted).toBeTruthy();
    expect(service.getApproval(approval.id)?.status).not.toBe('pending');
    expect(service.getApproval(approval.id)?.responseComment).toBe('3 / 1 / 1');
  });

  it('不需要文字的选项照旧一键即答', () => {
    const approval = requestFreeformChoice(service) as { id: string };
    const accepted = service.respondToApproval(approval.id, true, 'owner-1', undefined, 'no_publish');
    expect(accepted).toBeTruthy();
  });
});
