/**
 * 「反馈这个问题」——错误气泡底部的一键入口。
 *
 * 为什么自成一个组件、而不是把状态放进 MessageBubble：气泡是 `memo` 的，把弹窗
 * 开关提升上去会让每条消息多一份状态、并随消息列表重渲染；这里把「点开时才
 * 算一次草稿」完全关在自己身上，气泡只多渲染一个按钮。
 *
 * 草稿的计算在 `lib/errorFeedback.ts`（可脱离 DOM 断言），这个组件只负责
 * 「什么时候算」和「算完交给已有的 FeedbackModal」。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FeedbackModal } from './FeedbackModal.tsx';
import type { ChatMsg } from '../pages/ChatHelpers.ts';
import {
  buildErrorFeedbackDraft,
  errorFeedbackSourceFromMessage,
  type ErrorFeedbackDraft,
} from '../lib/errorFeedback.ts';

export function ErrorFeedbackButton({ msg }: { msg: ChatMsg }) {
  const { t } = useTranslation('common');
  const [draft, setDraft] = useState<ErrorFeedbackDraft | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setDraft(buildErrorFeedbackDraft(errorFeedbackSourceFromMessage(msg)))}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-fg-tertiary hover:text-fg-secondary transition-colors"
      >
        <svg
          className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" aria-hidden="true"
        >
          <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
          <path
            d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
            strokeLinejoin="round"
          />
        </svg>
        {t('feedback.reportThisError')}
      </button>
      {draft && (
        <FeedbackModal
          initialTitle={draft.title}
          initialBody={draft.body}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  );
}
