/**
 * Centralized chat state store using useSyncExternalStore.
 * Provides a Zustand-like API without the dependency.
 * Manages conversation buffers, unread counts, and sending state
 * so that the Team component no longer needs 30+ individual useState/useRef hooks.
 */

import { useSyncExternalStore } from 'react';
import type { ChatMsg, ChatMode } from './ChatHelpers.ts';
import type { ActivityStep } from '../components/ActivityIndicator.tsx';

const MAX_MESSAGES_PER_CONV = 500;
const MAX_BUFFERED_CONVERSATIONS = 20;

export interface ChatState {
  chatMode: ChatMode;
  selectedAgent: string;
  activeChannel: string;
  activeDmUserId: string;
  messages: ChatMsg[];
  activities: ActivityStep[];
  sending: boolean;
  streamingVisual: boolean;
}

type Listener = () => void;

class ChatStore {
  private listeners = new Set<Listener>();
  private msgBuffers = new Map<string, ChatMsg[]>();
  private actBuffers = new Map<string, ActivityStep[]>();
  private sendingConvs = new Set<string>();
  private currentConvKey = '';

  /** Refcount of in-flight streaming responses per agent (any conversation). */
  private streamingAgents = new Map<string, number>();
  private streamingTouchedAt = new Map<string, number>();
  private streamingVersion = 0;

  /**
   * Defensive TTL for a streaming mark. If a refcount stays > 0 for this long
   * it is a missed endStream pair (abort / stop / disconnect path), not a real
   * generation — a live SSE reply refreshes the touch far more often. Prevents
   * the sidebar showing "working" forever after an agent has stopped.
   */
  private static readonly STREAM_STALE_MS = 10 * 60 * 1000;

  /**
   * Mark an agent as having an active (streaming) response or the reverse.
   * Refcounted so multiple concurrent conversations with the same agent keep
   * it busy until the last stream ends. Always notifies subscribers — the
   * sidebar subscribes to this even when the edited conversation is not the
   * one currently in view.
   */
  markAgentStreaming(agentId: string | null | undefined, active: boolean): void {
    if (!agentId) return;
    const cur = this.streamingAgents.get(agentId) ?? 0;
    const next = Math.max(0, cur + (active ? 1 : -1));
    if (next === cur) return; // no change (e.g. defensive double endStream)
    if (next === 0) {
      this.streamingAgents.delete(agentId);
      this.streamingTouchedAt.delete(agentId);
    } else {
      this.streamingAgents.set(agentId, next);
      this.streamingTouchedAt.set(agentId, Date.now());
    }
    this.streamingVersion++;
    this.emit();
  }

  /**
   * Force-clear all streaming marks for an agent. Used when authoritative
   * backend state says the agent can no longer be generating (e.g. stopped),
   * so a stale frontend refcount can never pin the sidebar to "working".
   */
  clearAgentStreaming(agentId: string | null | undefined): void {
    if (!agentId) return;
    const had = this.streamingAgents.delete(agentId) || this.streamingTouchedAt.delete(agentId);
    if (had) {
      this.streamingVersion++;
      this.emit();
    }
  }

  getStreamingAgents(): ReadonlyMap<string, number> {
    // Lazy TTL sweep — a stuck refcount is a bug we must not let pin the UI.
    // Called during the sidebar render, so the cleaned map is read right away.
    if (this.streamingAgents.size === 0) return this.streamingAgents;
    const now = Date.now();
    for (const [id, touchedAt] of this.streamingTouchedAt) {
      if (now - touchedAt > ChatStore.STREAM_STALE_MS) {
        this.streamingAgents.delete(id);
        this.streamingTouchedAt.delete(id);
      }
    }
    return this.streamingAgents;
  }

  isAgentStreaming(agentId: string | null | undefined): boolean {
    return !!agentId && (this.streamingAgents.get(agentId) ?? 0) > 0;
  }

  /** Monotonic counter that changes whenever the streaming set changes. */
  getStreamingVersion(): number {
    return this.streamingVersion;
  }
  private rafPending: number | null = null;

  private state: ChatState = {
    chatMode: 'direct',
    selectedAgent: '',
    activeChannel: '',
    activeDmUserId: '',
    messages: [],
    activities: [],
    sending: false,
    streamingVisual: false,
  };

  getState = (): ChatState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private setState(partial: Partial<ChatState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  setConvKey(key: string) {
    this.currentConvKey = key;
    this.setState({
      messages: this.msgBuffers.get(key) ?? [],
      activities: this.actBuffers.get(key) ?? [],
      sending: this.sendingConvs.has(key),
    });
  }

  getConvKey() {
    return this.currentConvKey;
  }

  getMsgBuffer(key: string) {
    return this.msgBuffers.get(key) ?? [];
  }

  updateMessages(key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) {
    let next = updater(this.msgBuffers.get(key) ?? []);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }
    this.msgBuffers.set(key, next);
    this.evictOld(key);
    if (this.currentConvKey === key) {
      this.setState({ messages: next });
    }
  }

  updateMessagesRaf(key: string, updater: (prev: ChatMsg[]) => ChatMsg[]) {
    let next = updater(this.msgBuffers.get(key) ?? []);
    if (next.length > MAX_MESSAGES_PER_CONV) {
      next = next.slice(-MAX_MESSAGES_PER_CONV);
    }
    this.msgBuffers.set(key, next);
    if (this.currentConvKey === key && this.rafPending === null) {
      this.rafPending = requestAnimationFrame(() => {
        this.rafPending = null;
        const latest = this.msgBuffers.get(key);
        if (latest && this.currentConvKey === key) {
          this.setState({ messages: [...latest] });
        }
      });
    }
  }

  appendActivity(key: string, step: ActivityStep) {
    const next = [...(this.actBuffers.get(key) ?? []), step];
    this.actBuffers.set(key, next);
    if (this.currentConvKey === key) {
      this.setState({ activities: next });
    }
  }

  clearActivities(key: string) {
    this.actBuffers.delete(key);
    if (this.currentConvKey === key) {
      this.setState({ activities: [] });
    }
  }

  setSending(key: string, sending: boolean) {
    if (sending) {
      this.sendingConvs.add(key);
    } else {
      this.sendingConvs.delete(key);
    }
    if (this.currentConvKey === key) {
      this.setState({ sending });
    }
  }

  isSending(key: string) {
    return this.sendingConvs.has(key);
  }

  private evictOld(currentKey: string) {
    if (this.msgBuffers.size <= MAX_BUFFERED_CONVERSATIONS) return;
    const keys = [...this.msgBuffers.keys()];
    const toEvict = keys
      .filter(k => k !== currentKey && k !== this.currentConvKey)
      .slice(0, keys.length - MAX_BUFFERED_CONVERSATIONS);
    for (const k of toEvict) {
      this.msgBuffers.delete(k);
      this.actBuffers.delete(k);
    }
  }

  destroy() {
    if (this.rafPending !== null) cancelAnimationFrame(this.rafPending);
    this.listeners.clear();
  }
}

export const chatStore = new ChatStore();

export function useChatStore(): ChatState;
export function useChatStore<T>(selector: (s: ChatState) => T): T;
export function useChatStore<T>(selector?: (s: ChatState) => T) {
  const sel = selector ?? ((s: ChatState) => s as unknown as T);
  return useSyncExternalStore(
    chatStore.subscribe,
    () => sel(chatStore.getState()),
  );
}
