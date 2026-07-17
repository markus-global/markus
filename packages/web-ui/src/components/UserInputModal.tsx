import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ApprovalInfo, UserInputQuestion, UserInputAnswer } from '../api.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

interface Props {
  approval: ApprovalInfo;
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (result: {
    approved: boolean;
    comment?: string;
    selectedOption?: string;
    answers?: UserInputAnswer[];
  }) => void | Promise<void>;
}

interface DraftAnswer {
  selectedOptionIds: string[];
  text: string;
}

/**
 * Derive a normalized question list from an approval.
 * - If the approval carries explicit `questions`, use them.
 * - Else if it carries `options`, synthesize a single choice question.
 * - Else fall back to a single free-text question.
 */
function deriveQuestions(a: ApprovalInfo): UserInputQuestion[] {
  if (a.questions && a.questions.length > 0) return a.questions;
  if (a.options && a.options.length > 0) {
    return [{
      id: 'q1',
      prompt: a.description || a.title,
      inputType: 'choice',
      options: a.options,
      allowMultiple: false,
      allowFreeform: a.allowFreeform,
    }];
  }
  return [{
    id: 'q1',
    prompt: a.description || a.title,
    inputType: 'text',
    allowFreeform: true,
  }];
}

export function UserInputModal({ approval, submitting, onClose, onSubmit }: Props) {
  const { t } = useTranslation(['team', 'common']);
  const questions = useMemo(() => deriveQuestions(approval), [approval]);
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});

  const current = questions[step];
  const isLast = step === questions.length - 1;
  const multiQuestion = questions.length > 1;

  const draftFor = (qid: string): DraftAnswer => drafts[qid] ?? { selectedOptionIds: [], text: '' };

  const setDraft = (qid: string, patch: Partial<DraftAnswer>) => {
    setDrafts(prev => ({ ...prev, [qid]: { ...draftFor(qid), ...patch } }));
  };

  const toggleOption = (q: UserInputQuestion, optId: string) => {
    const d = draftFor(q.id);
    if (q.allowMultiple) {
      const has = d.selectedOptionIds.includes(optId);
      setDraft(q.id, { selectedOptionIds: has ? d.selectedOptionIds.filter(x => x !== optId) : [...d.selectedOptionIds, optId] });
    } else {
      setDraft(q.id, { selectedOptionIds: [optId] });
    }
  };

  const isAnswered = (q: UserInputQuestion): boolean => {
    const d = draftFor(q.id);
    if (q.inputType === 'choice') {
      if (d.selectedOptionIds.length > 0) return true;
      return !!(q.allowFreeform && d.text.trim());
    }
    return d.text.trim().length > 0;
  };

  const allAnswered = questions.every(isAnswered);

  const buildAnswers = (): UserInputAnswer[] => questions.map(q => {
    const d = draftFor(q.id);
    const ans: UserInputAnswer = { questionId: q.id };
    if (d.selectedOptionIds.length > 0) ans.selectedOptionIds = d.selectedOptionIds;
    if (d.text.trim()) ans.text = d.text.trim();
    return ans;
  });

  const handleSubmit = () => {
    const answers = buildAnswers();
    // Legacy single-choice approvals: preserve approved/selectedOption semantics.
    let approved = true;
    let selectedOption: string | undefined;
    if (!approval.questions?.length && approval.options?.length) {
      const first = answers[0];
      selectedOption = first?.selectedOptionIds?.[0] ?? (first?.text ? 'custom' : undefined);
      approved = selectedOption !== 'reject' && selectedOption !== 'request_changes';
    }
    const comment = answers.map(a => a.text).filter(Boolean).join('\n') || undefined;
    onSubmit({ approved, comment, selectedOption, answers });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface-secondary border border-border-default rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-6 py-4 border-b border-border-default shrink-0">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" /><path d="M12 8v4" /><path d="M12 16h.01" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg-primary leading-snug">{approval.title}</h2>
            <p className="text-xs text-fg-tertiary mt-0.5">{approval.agentName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-fg-tertiary hover:text-fg-primary rounded-md hover:bg-surface-overlay transition-colors shrink-0"
            title={t('common:close')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {multiQuestion && (
            <div className="flex items-center gap-2">
              {questions.map((q, i) => (
                <button
                  key={q.id}
                  onClick={() => setStep(i)}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    i === step ? 'bg-brand-500' : isAnswered(q) ? 'bg-green-500/60' : 'bg-border-default'
                  }`}
                  title={`${i + 1}. ${q.prompt.slice(0, 40)}`}
                />
              ))}
            </div>
          )}
          {multiQuestion && (
            <div className="text-[11px] font-medium text-fg-tertiary">
              {t('team:userInput.questionProgress', { current: step + 1, total: questions.length, defaultValue: `Question ${step + 1} of ${questions.length}` })}
            </div>
          )}

          <div className="text-sm text-fg-primary leading-relaxed">
            <MarkdownMessage content={current.prompt} />
          </div>

          {current.inputType === 'choice' && current.options && (
            <div className="space-y-2">
              {current.options.map((opt, idx) => {
                const selected = draftFor(current.id).selectedOptionIds.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    onClick={() => toggleOption(current, opt.id)}
                    className={`w-full px-4 py-3 text-left rounded-xl border transition-colors flex items-start gap-3 ${
                      selected
                        ? 'border-brand-500 bg-brand-500/10'
                        : 'border-border-default hover:bg-surface-overlay'
                    }`}
                  >
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5 ${
                      selected ? 'bg-brand-600 text-white' : 'bg-surface-overlay text-fg-tertiary'
                    }`}>
                      {selected
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                        : String.fromCharCode(65 + idx)}
                    </span>
                    <span className="flex-1 min-w-0 text-sm text-fg-primary [&_p]:my-0 [&_p]:text-sm">
                      <MarkdownMessage content={opt.label} />
                      {opt.description && (
                        <span className="block text-xs text-fg-tertiary mt-1 [&_p]:my-0 [&_p]:text-xs">
                          <MarkdownMessage content={opt.description} />
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {(current.inputType === 'text' || current.allowFreeform) && (
            <textarea
              rows={current.inputType === 'text' ? 4 : 2}
              placeholder={current.inputType === 'text'
                ? t('team:userInput.textPlaceholder', { defaultValue: 'Type your answer…' })
                : t('team:userInput.freeformPlaceholder', { defaultValue: 'Or write your own answer…' })}
              value={draftFor(current.id).text}
              onChange={e => setDraft(current.id, { text: e.target.value })}
              className="w-full px-3.5 py-2.5 text-sm bg-surface-overlay border border-border-default rounded-xl text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50 resize-y"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-border-default shrink-0">
          <div>
            {multiQuestion && step > 0 && (
              <button
                onClick={() => setStep(s => Math.max(0, s - 1))}
                className="px-4 py-2 text-sm font-medium text-fg-secondary border border-border-default rounded-lg hover:bg-surface-overlay transition-colors"
              >
                {t('team:userInput.previous', { defaultValue: 'Previous' })}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {multiQuestion && !isLast ? (
              <button
                disabled={!isAnswered(current)}
                onClick={() => setStep(s => Math.min(questions.length - 1, s + 1))}
                className="px-5 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors"
              >
                {t('team:userInput.next', { defaultValue: 'Next' })}
              </button>
            ) : (
              <button
                disabled={submitting || !allAnswered}
                onClick={handleSubmit}
                className="px-5 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
              >
                {submitting && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {t('team:userInput.submit', { defaultValue: 'Submit' })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
