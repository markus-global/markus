const BASE = '/api';

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts?.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedAgentId?: string;
}

export const api = {
  agents: {
    list: () => request<{ agents: AgentInfo[] }>('/agents'),
    create: (name: string, roleName: string) =>
      request('/agents', { method: 'POST', body: JSON.stringify({ name, roleName }) }),
    start: (id: string) => request(`/agents/${id}/start`, { method: 'POST' }),
    stop: (id: string) => request(`/agents/${id}/stop`, { method: 'POST' }),
    remove: (id: string) => request(`/agents/${id}`, { method: 'DELETE' }),
    message: (id: string, text: string) =>
      request<{ reply: string }>(`/agents/${id}/message`, { method: 'POST', body: JSON.stringify({ text }) }),
    messageStream: (id: string, text: string, onChunk: (chunk: string) => void): Promise<string> => {
      return new Promise(async (resolve, reject) => {
        try {
          const res = await fetch(`${BASE}/agents/${id}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, stream: true }),
          });
          if (!res.ok) { reject(new Error(`API error: ${res.status}`)); return; }
          const reader = res.body?.getReader();
          if (!reader) { reject(new Error('No reader')); return; }
          const decoder = new TextDecoder();
          let fullContent = '';
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(trimmed.slice(6)) as { type: string; text?: string; content?: string };
                if (event.type === 'text_delta' && event.text) {
                  fullContent += event.text;
                  onChunk(event.text);
                } else if (event.type === 'done') {
                  fullContent = event.content ?? fullContent;
                }
              } catch { /* skip */ }
            }
          }
          resolve(fullContent);
        } catch (err) { reject(err); }
      });
    },
  },
  roles: {
    list: () => request<{ roles: string[] }>('/roles'),
  },
  tasks: {
    list: () => request<{ tasks: TaskInfo[] }>('/tasks'),
    create: (title: string, description: string, priority?: string, assignedAgentId?: string, autoAssign?: boolean) =>
      request('/tasks', { method: 'POST', body: JSON.stringify({ title, description, priority, assignedAgentId, autoAssign }) }),
    updateStatus: (id: string, status: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) }),
    assign: (id: string, agentId: string) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ assignedAgentId: agentId }) }),
    board: () => request<{ board: Record<string, TaskInfo[]> }>('/taskboard'),
  },
  health: () => request<{ status: string; version: string; agents: number }>('/health'),
};

export interface WSEvent {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

type WSEventHandler = (event: WSEvent) => void;

class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<WSEventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3001/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as WSEvent;
        const typeHandlers = this.handlers.get(event.type);
        if (typeHandlers) {
          for (const handler of typeHandlers) handler(event);
        }
        const allHandlers = this.handlers.get('*');
        if (allHandlers) {
          for (const handler of allHandlers) handler(event);
        }
      } catch { /* ignore parse errors */ }
    };

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  on(type: string, handler: WSEventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }
}

export const wsClient = new WSClient();
