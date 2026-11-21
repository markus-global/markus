import { Notification, BrowserWindow, app } from 'electron';
import WebSocket from 'ws';
import { taskUpdateOsText, notificationOsText } from './notification-text.js';

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
      const status = payload?.status as string | undefined;
      const title = payload?.title as string | undefined;
      const taskId = payload?.taskId as string | undefined;
      // A task notification must name the task. Task-service always sends the
      // title; a title-less `task:update` is an internal signal that must not be
      // dressed up as an OS notification. The words come from the notification
      // vocabulary in the reader's language (notification-text.ts) — the same
      // sentence the in-app inbox and Feishu show, not baked English literals.
      const text = taskUpdateOsText(status, title, app.getLocale());
      if (!text) break;
      showOSNotification(text.title, text.body, {
        openNotifications: true,
        page: 'work', params: taskId ? { openTask: taskId } : undefined,
      });
      break;
    }

    // NOTE: `case 'task:completed'` used to live here, but the WS server never
    // emits that event type (`broadcastTaskUpdate` emits `task:update`) — it was
    // unreachable. Task status reaches the OS through the `task:update` case
    // above, which now requires a title.
    //
    // NOTE: `case 'approval:requested'` was removed for the same reason — no WS
    // path emits it. An approval reaches the OS as an approval_request
    // notification through the localized `notification` case below.

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
      // Localize from metadata.i18n (the same path the in-app bell uses) instead
      // of copying the producer's baked-in English title/body to the OS.
      const n = (payload?.notification ?? payload) as Record<string, unknown> | undefined;
      const { title, body } = notificationOsText(n, app.getLocale());
      const meta = (n?.metadata ?? {}) as Record<string, string>;
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
