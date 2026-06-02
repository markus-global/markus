/**
 * Centralized chat state store using useSyncExternalStore.
 * Provides a Zustand-like API without the dependency.
 * Manages conversation buffers, unread counts, and sending state
 * so that the Team component no longer needs 30+ individual useState/useRef hooks.
 */

import { useSyncExternalStore, useCallback, useRef } from 'react';
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
