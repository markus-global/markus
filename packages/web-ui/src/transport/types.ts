export interface Transport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openWebSocket(path: string, userId?: string): WebSocket | WebSocketLike;
  close(): void;
}

export interface WebSocketLike {
  onmessage: ((e: MessageEvent) => void) | null;
  onclose: ((e: CloseEvent | Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'relay';
