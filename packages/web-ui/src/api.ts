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
  },
  roles: {
    list: () => request<{ roles: string[] }>('/roles'),
  },
  tasks: {
    list: () => request<{ tasks: TaskInfo[] }>('/tasks'),
    create: (title: string, description: string, priority?: string) =>
      request('/tasks', { method: 'POST', body: JSON.stringify({ title, description, priority }) }),
    board: () => request<{ board: Record<string, TaskInfo[]> }>('/taskboard'),
  },
  health: () => request<{ status: string; version: string; agents: number }>('/health'),
};
