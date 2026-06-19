import { Notification, BrowserWindow } from 'electron';
import WebSocket from 'ws';

interface WSEvent {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

interface NavContext {
  page?: string;
  params?: Record<string, string>;
  openNotifications?: boolean;
}

let wsClient: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function startNotificationBridge(backendUrl: string): void {
  connectWS(backendUrl);
}

export function stopNotificationBridge(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
}

function connectWS(backendUrl: string): void {
  const wsUrl = backendUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';

  try {
    wsClient = new WebSocket(wsUrl);

    wsClient.on('message', (data) => {
      try {
        const event: WSEvent = JSON.parse(data.toString());
        handleEvent(event);
      } catch { /* malformed message */ }
    });

    wsClient.on('close', () => {
      scheduleReconnect(backendUrl);
    });

    wsClient.on('error', () => {
      wsClient?.close();
    });
  } catch {
    scheduleReconnect(backendUrl);
  }
}

function scheduleReconnect(backendUrl: string): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS(backendUrl);
  }, 5000);
}

function handleEvent(event: WSEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;

  switch (event.type) {
    case 'task:update': {
      const status = payload?.status as string;
      const title = (payload?.title as string) ?? 'Task';
      const taskId = payload?.taskId as string | undefined;
      if (status === 'completed') {
        showOSNotification('Task Completed', `✓ ${title}`, {
          openNotifications: true,
          page: 'work', params: taskId ? { openTask: taskId } : undefined,
        });
      } else if (status === 'failed') {
        showOSNotification('Task Failed', `✗ ${title}`, {
          openNotifications: true,
          page: 'work', params: taskId ? { openTask: taskId } : undefined,
        });
      } else if (status === 'review') {
        showOSNotification('Review Required', `${title} needs review`, {
          openNotifications: true,
          page: 'work', params: taskId ? { openTask: taskId } : undefined,
        });
      }
      break;
    }

    case 'task:completed': {
      const title = (payload?.title as string) ?? (payload?.taskId as string) ?? 'Task';
      const taskId = (payload?.taskId as string) ?? undefined;
      showOSNotification('✅ Task Completed', title, {
        openNotifications: true,
        page: 'work', params: taskId ? { openTask: taskId } : undefined,
      });
      break;
    }

    case 'approval:requested': {
      const taskId = payload?.taskId as string | undefined;
      const agentId = payload?.agentId as string | undefined;
      showOSNotification(
        '🔔 Approval Required',
        (payload?.title as string) ?? 'An agent needs your approval',
        {
          openNotifications: true,
          page: taskId ? 'work' : agentId ? 'team' : undefined,
          params: taskId ? { openTask: taskId } : agentId ? { agentId } : undefined,
        },
      );
      break;
    }

    case 'chat:message':
      if (payload?.notifyUser) {
        const agentId = payload?.agentId as string | undefined;
        const sessionId = payload?.sessionId as string | undefined;
        const params: Record<string, string> = {};
        if (agentId) params.agentId = agentId;
        if (sessionId) params.sessionId = sessionId;
        showOSNotification(
          (payload.agentName as string) ?? 'Markus Agent',
          ((payload.text as string) ?? '').slice(0, 100),
          {
            openNotifications: true,
            page: 'team',
            params: Object.keys(params).length > 0 ? params : undefined,
          },
        );
      }
      break;

    case 'notification': {
      const n = payload?.notification as Record<string, unknown> | undefined;
      const title = (n?.title as string) ?? (payload?.title as string) ?? 'Markus';
      const body = (n?.body as string) ?? (payload?.body as string) ?? '';
      const meta = (n?.metadata ?? payload?.metadata ?? {}) as Record<string, string>;
      showOSNotification(title, body, {
        openNotifications: true,
        ...buildNavFromMeta(meta),
      });
      break;
    }
  }
}

function buildNavFromMeta(meta: Record<string, string>): Pick<NavContext, 'page' | 'params'> {
  if (meta.taskId) return { page: 'work', params: { openTask: meta.taskId } };
  if (meta.requirementId) return { page: 'work', params: { openRequirement: meta.requirementId } };
  if (meta.agentId) {
    const params: Record<string, string> = { agentId: meta.agentId };
    if (meta.sessionId) params.sessionId = meta.sessionId;
    return { page: 'team', params };
  }
  return {};
}

function showOSNotification(title: string, body: string, nav?: NavContext): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.isFocused()) return;

  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        if (nav) {
          win.webContents.send('notification:navigate', nav);
        }
      }
    });
    notification.show();
  }
}
