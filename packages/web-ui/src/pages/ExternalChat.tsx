/**
 * ExternalChat - Standalone chat page for external users via share links.
 *
 * Accessed at /ext/:token — no internal auth required.
 * Uses app design tokens (dark/light compatible), supports SSE streaming,
 * typing indicators, custom UI configs, and mobile-responsive design.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { DynamicUIRenderer } from '../components/DynamicUIRenderer.js';
import { MarkdownMessage } from '../components/MarkdownMessage.js';

interface AgentInfo {
  agentId: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  welcomeMessage?: string;
  inputPlaceholder?: string;
  uiMode: 'default' | 'custom';
  uiConfig?: CustomUIConfig;
  permissions: { canChat: boolean; canUploadFiles: boolean };
  maxMessagesPerSession?: number;
  tokenBudgetPerSession?: number;
}

interface CustomUIConfig {
  layout: 'fullpage' | 'widget' | 'sidebar';
  theme: { primaryColor: string; backgroundColor?: string; textColor?: string; fontFamily?: string; borderRadius?: string; logoUrl?: string; faviconUrl?: string };
  components: Array<{ type: string; position: string; config: Record<string, unknown>; showWhen?: string }>;
  welcomeMessage?: string;
  placeholder?: string;
  customCss?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  streaming?: boolean;
  error?: boolean;
  toolName?: string;
}

interface ExternalChatProps {
  token?: string;
}

export function ExternalChat({ token: propToken }: ExternalChatProps) {
  const { t } = useTranslation('agent');
  const [token] = useState(() => propToken ?? extractTokenFromUrl());
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [rating, setRating] = useState<number>(0);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [toolInProgress, setToolInProgress] = useState<string | null>(null);
  const [tokensUsed, setTokensUsed] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sseBufferRef = useRef('');

  const messageCount = messages.filter(m => m.role === 'user').length;
  const maxMessages = agentInfo?.maxMessagesPerSession ?? 0;
  const maxTokens = agentInfo?.tokenBudgetPerSession ?? 0;
  const nearMessageLimit = maxMessages > 0 && messageCount >= maxMessages * 0.8;
  const nearTokenLimit = maxTokens > 0 && tokensUsed >= maxTokens * 0.8;

  useEffect(() => {
    if (!token) {
      setError(t('external.chat.noToken'));
      return;
    }
    fetchAgentInfo(token);
  }, [token]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [inputValue]);

  const fetchAgentInfo = async (t_: string) => {
    try {
      const res = await fetch(`/api/external/share/info?token=${encodeURIComponent(t_)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          setError(t('external.chat.linkExpired'));
        } else {
          setError(data.error ?? t('external.chat.loadFailed'));
        }
        return;
      }
      const info: AgentInfo = await res.json();
      setAgentInfo(info);
      if (info.uiConfig?.theme?.faviconUrl) {
        updateFavicon(info.uiConfig.theme.faviconUrl);
      }
      document.title = t('external.chat.pageTitle', { name: info.name });
    } catch {
      setError(t('external.chat.networkError'));
    }
  };

  const startSession = async () => {
    if (!token) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/external/session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError(t('external.chat.serviceBusy'));
        } else if (res.status === 401) {
          setError(t('external.chat.linkExpired'));
        } else {
          setError(data.error ?? t('external.chat.startFailed'));
        }
        return;
      }
      const data = await res.json();
      setSessionId(data.sessionId);
      const welcome = data.welcomeMessage ?? agentInfo?.welcomeMessage;
      if (welcome) {
        setMessages([{
          id: 'welcome',
          role: 'assistant',
          content: welcome,
          timestamp: new Date().toISOString(),
        }]);
      }
    } catch {
      setError(t('external.chat.connectionFailed'));
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = useCallback(async (overrideContent?: string) => {
    const content = overrideContent ?? inputValue.trim();
    if (!content || !sessionId || !token || loading) return;

    if (!overrideContent) setInputValue('');
    setRetryMessage(null);
    setError(null);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    const assistantMsgId = `msg_${Date.now()}_a`;
    setMessages(prev => [...prev, {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true,
    }]);

    try {
      abortRef.current = new AbortController();
      sseBufferRef.current = '';
      const res = await fetch('/api/external/session/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ sessionId, content, token }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
        if (res.status === 429) {
          setError(t('external.chat.rateLimited'));
        } else if (res.status === 403 || res.status === 401) {
          setError(t('external.chat.sessionExpired'));
        } else {
          setRetryMessage(content);
          setError(data.error ?? t('external.chat.responseFailed'));
        }
        return;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        await handleStreamingResponse(res, assistantMsgId);
      } else {
        const data = await res.json();
        setMessages(prev => prev.map(m =>
          m.id === assistantMsgId
            ? { ...m, content: data.response, streaming: false }
            : m
        ));
        if (data.tokensUsed) setTokensUsed(prev => prev + data.tokensUsed);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setMessages(prev => prev.filter(m => m.id !== assistantMsgId));
      setRetryMessage(content);
      setError(t('external.chat.connectionLost'));
    } finally {
      setLoading(false);
      setToolInProgress(null);
      abortRef.current = null;
    }
  }, [inputValue, sessionId, token, loading, t]);

  const handleStreamingResponse = async (res: Response, msgId: string) => {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const event = JSON.parse(data);
            switch (event.type) {
              case 'text_delta':
                accumulated += event.content;
                setMessages(prev => prev.map(m =>
                  m.id === msgId ? { ...m, content: accumulated } : m
                ));
                break;
              case 'tool_start':
                setToolInProgress(event.content);
                break;
              case 'tool_end':
                setToolInProgress(null);
                break;
              case 'error':
                setMessages(prev => prev.map(m =>
                  m.id === msgId ? { ...m, content: accumulated || event.content, streaming: false, error: true } : m
                ));
                return;
              case 'done':
                if (event.metadata?.tokensUsed) {
                  setTokensUsed(prev => prev + event.metadata.tokensUsed);
                }
                return;
            }
          } catch { /* skip malformed JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, streaming: false } : m
      ));
    }
  };

  const endSession = async () => {
    abortRef.current?.abort();
    if (!sessionId || !token) return;
    try {
      await fetch('/api/external/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token }),
      });
    } catch { /* best-effort */ }
    setSessionEnded(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const retry = () => {
    if (retryMessage) {
      setError(null);
      sendMessage(retryMessage);
    }
  };

  const submitRatingValue = async (value: number) => {
    setRating(value);
    if (!sessionId || !token) return;
    try {
      const res = await fetch('/api/external/session/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token, rating: value }),
      });
      if (res.ok) {
        setRatingSubmitted(true);
      }
    } catch { /* best-effort */ }
  };

  // ─── Error State (no session yet) ─────────────────────────────────────────
  if (error && !sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
        <div className="bg-surface-elevated rounded-2xl shadow-lg p-10 max-w-sm text-center border border-border-default">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
          </div>
          <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('external.chat.unableToConnect')}</h2>
          <p className="text-sm text-fg-tertiary mb-6">{error}</p>
          <button
            onClick={() => { setError(null); fetchAgentInfo(token); }}
            className="px-5 py-2.5 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-500 transition-colors"
          >
            {t('external.chat.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Loading State ─────────────────────────────────────────────────────────
  if (!agentInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-border-default border-t-brand-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-fg-tertiary">{t('external.chat.loadingAgent')}</p>
        </div>
      </div>
    );
  }

  // ─── Welcome / Start Session ───────────────────────────────────────────────
  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
        <div className="bg-surface-elevated rounded-2xl shadow-xl p-10 max-w-md text-center border border-border-default">
          {agentInfo.avatarUrl ? (
            <img src={agentInfo.avatarUrl} alt={agentInfo.name} className="w-20 h-20 rounded-2xl object-cover mx-auto mb-5 shadow-md" />
          ) : (
            <div className="w-20 h-20 rounded-2xl bg-brand-600 flex items-center justify-center mx-auto mb-5 shadow-md">
              <span className="text-2xl font-bold text-white">{agentInfo.name.charAt(0).toUpperCase()}</span>
            </div>
          )}
          <h1 className="text-2xl font-bold text-fg-primary mb-2">{agentInfo.name}</h1>
          {agentInfo.description && <p className="text-sm text-fg-tertiary mb-6 leading-relaxed">{agentInfo.description}</p>}
          <button
            onClick={startSession}
            disabled={loading}
            className="w-full px-6 py-3 bg-brand-600 text-white font-medium rounded-xl hover:bg-brand-500 disabled:opacity-50 disabled:cursor-wait transition-all shadow-sm"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t('external.chat.connecting')}
              </span>
            ) : t('external.chat.startConversation')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Session Ended ─────────────────────────────────────────────────────────
  if (sessionEnded) {
    const endedContent = (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        </div>
        <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('external.chat.conversationEnded')}</h2>
        <p className="text-sm text-fg-tertiary mb-5">{t('external.chat.thankYou', { name: agentInfo.name })}</p>

        {/* Star Rating */}
        {!ratingSubmitted ? (
          <div className="mb-6 text-center">
            <p className="text-sm text-fg-secondary mb-2">{t('external.chat.rateExperience')}</p>
            <div className="flex items-center justify-center gap-1">
              {[1, 2, 3, 4, 5].map(star => (
                <button
                  key={star}
                  onClick={() => submitRatingValue(star)}
                  className="p-1 transition-transform hover:scale-110"
                  aria-label={t('external.chat.rateStar', { n: star })}
                >
                  <svg className={`w-7 h-7 ${star <= rating ? 'text-amber-400 fill-amber-400' : 'text-fg-muted'}`} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-green-400 mb-6">{t('external.chat.ratingThanks')}</p>
        )}

        <button
          onClick={() => { setSessionId(null); setSessionEnded(false); setMessages([]); setRating(0); setRatingSubmitted(false); setTokensUsed(0); }}
          className="px-5 py-2.5 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-500 transition-colors"
        >
          {t('external.chat.newConversation')}
        </button>
      </div>
    );

    if (agentInfo.uiMode === 'custom' && agentInfo.uiConfig) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
          <DynamicUIRenderer config={agentInfo.uiConfig as any} sessionState="ended" onRatingSubmit={(r) => submitRatingValue(r)}>
            {endedContent}
          </DynamicUIRenderer>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
        <div className="bg-surface-elevated rounded-2xl shadow-lg p-10 max-w-sm text-center border border-border-default">
          {endedContent}
        </div>
      </div>
    );
  }

  // ─── Active Chat ───────────────────────────────────────────────────────────
  const chatContent = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-default bg-surface-secondary">
        <div className="flex items-center gap-3">
          {agentInfo.avatarUrl ? (
            <img src={agentInfo.avatarUrl} alt="" className="w-9 h-9 rounded-xl object-cover" />
          ) : (
            <div className="w-9 h-9 rounded-xl bg-brand-600 flex items-center justify-center">
              <span className="text-sm font-bold text-white">{agentInfo.name.charAt(0).toUpperCase()}</span>
            </div>
          )}
          <div>
            <span className="font-semibold text-sm text-fg-primary">{agentInfo.name}</span>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <span className="text-xs text-fg-muted">{t('external.chat.online')}</span>
            </div>
          </div>
        </div>
        <button
          onClick={endSession}
          className="px-3 py-1.5 text-xs font-medium text-fg-tertiary bg-surface-elevated rounded-lg hover:bg-surface-overlay hover:text-fg-secondary transition-colors"
        >
          {t('external.chat.endChat')}
        </button>
      </div>

      {/* Limit warnings */}
      {(nearMessageLimit || nearTokenLimit) && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400 text-center">
          {nearMessageLimit && t('external.chat.messageLimitWarning', { current: messageCount, max: maxMessages })}
          {nearMessageLimit && nearTokenLimit && ' | '}
          {nearTokenLimit && t('external.chat.tokenLimitWarning')}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-2.5 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-brand-600 text-white rounded-2xl rounded-br-md whitespace-pre-wrap'
                : 'bg-surface-chat-bubble text-fg-primary rounded-2xl rounded-bl-md'
            } ${msg.error ? 'border border-red-500/30' : ''} ${msg.streaming && !msg.content ? 'opacity-60' : ''}`}>
              {msg.role === 'user' ? (
                msg.content
              ) : msg.content ? (
                <>
                  <MarkdownMessage content={msg.content} className="text-fg-primary [&_a]:text-brand-400" />
                  {msg.streaming && <span className="inline-block ml-0.5 animate-pulse">▍</span>}
                </>
              ) : msg.streaming ? (
                <TypingIndicator />
              ) : null}
            </div>
          </div>
        ))}

        {/* Tool in progress indicator */}
        {toolInProgress && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-fg-muted bg-surface-chat-bubble rounded-xl">
              <span className="w-3 h-3 border-2 border-fg-muted/30 border-t-fg-muted rounded-full animate-spin" />
              {t('external.chat.usingTool', { tool: toolInProgress })}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Error bar */}
      {error && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-red-500/10 border-t border-red-500/20">
          <span className="text-xs text-red-400">{error}</span>
          {retryMessage && (
            <button onClick={retry} className="px-3 py-1 text-xs font-medium text-white bg-red-500 rounded hover:bg-red-600 transition-colors">
              {t('external.chat.retry')}
            </button>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="flex items-end gap-2 px-4 py-3 border-t border-border-default bg-surface-secondary">
        <textarea
          ref={textareaRef}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={agentInfo.uiConfig?.placeholder ?? agentInfo.inputPlaceholder ?? t('external.chat.inputPlaceholder')}
          className="flex-1 px-4 py-2.5 text-sm bg-surface-elevated border border-border-default rounded-xl text-fg-primary placeholder:text-fg-muted resize-none outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 transition-all"
          style={{ minHeight: 40, maxHeight: 120 }}
          rows={1}
          disabled={loading}
        />
        <button
          onClick={() => sendMessage()}
          disabled={!inputValue.trim() || loading}
          className="p-2.5 bg-brand-600 text-white rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand-500 transition-colors"
          aria-label={t('external.chat.send')}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m-7 7l7-7 7 7" /></svg>
        </button>
      </div>
    </div>
  );

  if (agentInfo.uiMode === 'custom' && agentInfo.uiConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
        <DynamicUIRenderer config={agentInfo.uiConfig as any} sessionState="active">
          {chatContent}
        </DynamicUIRenderer>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-primary p-4">
      <div className="w-full max-w-2xl h-[90vh] max-h-[800px] bg-surface-elevated rounded-2xl shadow-xl border border-border-default overflow-hidden flex flex-col">
        {chatContent}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      <span className="w-1.5 h-1.5 bg-fg-muted rounded-full animate-bounce [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 bg-fg-muted rounded-full animate-bounce [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 bg-fg-muted rounded-full animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

function extractTokenFromUrl(): string {
  const path = window.location.pathname;
  const match = path.match(/^\/ext\/(.+)$/);
  if (match) return decodeURIComponent(match[1]!);
  const hash = window.location.hash;
  const hashMatch = hash.match(/^#ext\/(.+)$/);
  if (hashMatch) return decodeURIComponent(hashMatch[1]!);
  const params = new URLSearchParams(window.location.search);
  return params.get('token') ?? '';
}

function updateFavicon(url: string) {
  let link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = url;
}

export default ExternalChat;
