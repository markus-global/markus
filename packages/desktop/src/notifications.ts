import { Notification, BrowserWindow } from 'electron';
import WebSocket from 'ws';

interface WSEvent {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
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
    case 'task:completed':
      showOSNotification(
        'Task Completed',
        `Task has been completed${payload?.agentId ? ` by agent` : ''}`,
        'task_complete',
      );
      break;

    case 'approval:requested':
      showOSNotification(
        'Approval Required',
        (payload?.title as string) ?? 'An agent needs your approval',
        'approval',
      );
      break;

    case 'chat:message':
      if (payload?.notifyUser) {
        showOSNotification(
          (payload.agentName as string) ?? 'Markus Agent',
          ((payload.text as string) ?? '').slice(0, 100),
          'mention',
        );
      }
      break;

    case 'notification':
      showOSNotification(
        (payload?.title as string) ?? 'Markus',
        (payload?.body as string) ?? '',
        (payload?.type as string) ?? 'info',
      );
      break;
  }
}

function showOSNotification(title: string, body: string, type: string): void {
  // Don't show notifications if the app window is focused
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.isFocused()) return;

  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    notification.show();
  }

  // Also forward to renderer for in-app display
  if (win) {
    win.webContents.send('notification:show', { title, body, type });
  }
}
