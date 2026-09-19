/**
 * chatStore — the ONLY cross-component chat state in the app.
 *
 * Single responsibility: track which agents currently have an in-flight
 * streaming reply on THIS client, so the sidebar (ChatTeamSidebar) and the
 * top badge can share one busy signal.
 *
 * Everything per-conversation lives in ConversationBufferManager (pure class,
 * keyed by convKey), NOT here. The old ChatState fields (chatMode, messages,
 * sending, activities, streamingVisual…) were dead code — never written by
 * any caller — and were a trap: a future reader could mistake this store for
 * the global chat state and create a silent second source of truth. Removed.
 */

import { useSyncExternalStore } from 'react';

type Listener = () => void;

class ChatStore {
  private listeners = new Set<Listener>();

  /**
   * Agents that currently have an in-flight streaming reply on THIS client.
   *
   * This is a plain idempotent Set, NOT a refcount. The add/remove pairing is
   * structurally guaranteed (not by convention): adds happen in beginStream /
   * setStreamSession, and the ONLY remove path is clearStreamSession — every
   * stream lifecycle (done, abort, stop, soft-disconnect→reattach, session
   * switch, retry) funnels through that single removal point. Because the set
   * is idempotent, accidental double-begin can never pin an agent busy.
   */
  private streamingAgents = new Set<string>();
  private streamingVersion = 0;

  /**
   * Mark an agent as having an active (streaming) response or the reverse.
   * Idempotent set membership — repeated begin / repeated end are safe by
   * construction (no refcount can leak or go negative).
   */
  markAgentStreaming(agentId: string | null | undefined, active: boolean): void {
    if (!agentId) return;
    const had = this.streamingAgents.has(agentId);
    if (active && !had) {
      this.streamingAgents.add(agentId);
      this.streamingVersion++;
      this.emit();
    } else if (!active && had) {
      this.streamingAgents.delete(agentId);
      this.streamingVersion++;
      this.emit();
    }
  }

  /**
   * Force-clear the streaming mark for an agent. Called when backend
   * authoritative state says the agent can no longer be generating (agent:update
   * → offline), so a stale local mark can never pin the sidebar to "working".
   */
  clearAgentStreaming(agentId: string | null | undefined): void {
    if (!agentId) return;
    if (this.streamingAgents.delete(agentId)) {
      this.streamingVersion++;
      this.emit();
    }
  }

  getStreamingAgents(): ReadonlySet<string> {
    return this.streamingAgents;
  }

  isAgentStreaming(agentId: string | null | undefined): boolean {
    return !!agentId && this.streamingAgents.has(agentId);
  }

  /** Monotonic counter that changes whenever the streaming set changes. */
  getStreamingVersion(): number {
    return this.streamingVersion;
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const chatStore = new ChatStore();

/**
 * Subscribe to streaming-set changes. Returns the current streaming version;
 * with a selector, returns the selected projection. Re-renders whenever the
 * version bumps (i.e. any agent began or finished streaming).
 */
export function useChatStore(): number;
export function useChatStore<T>(selector: (version: number) => T): T;
export function useChatStore<T>(selector?: (version: number) => T) {
  const sel = selector ?? ((v: number) => v as unknown as T);
  return useSyncExternalStore(
    chatStore.subscribe,
    () => sel(chatStore.getStreamingVersion()),
  );
}

/**
 * Reactive "this agent has an in-flight streaming reply on this client".
 *
 * Reading `chatStore.getStreamingAgents()` during render is NOT reactive — the
 * component only re-renders when something else happens to re-render it, so a
 * status chip can keep saying "空闲" until an unrelated state change. Every
 * status surface should use this hook instead.
 */
export function useAgentStreaming(agentId: string | null | undefined): boolean {
  return useChatStore(() => chatStore.isAgentStreaming(agentId));
}