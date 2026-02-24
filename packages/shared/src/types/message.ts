export type MessageDirection = 'inbound' | 'outbound';
export type MessagePlatform = 'feishu' | 'whatsapp' | 'slack' | 'telegram' | 'webui' | 'internal';

export interface Message {
  id: string;
  platform: MessagePlatform;
  direction: MessageDirection;
  channelId: string;
  senderId: string;
  senderName: string;
  agentId: string;
  content: MessageContent;
  replyToId?: string;
  threadId?: string;
  timestamp: string;
}

export interface MessageContent {
  type: 'text' | 'rich_text' | 'file' | 'image' | 'action_card';
  text?: string;
  richText?: RichTextBlock[];
  fileUrl?: string;
  imageUrl?: string;
  actionCard?: ActionCard;
}

export interface RichTextBlock {
  tag: 'text' | 'a' | 'at' | 'code' | 'bold' | 'italic';
  text?: string;
  href?: string;
  userId?: string;
}

export interface ActionCard {
  title: string;
  text: string;
  actions: ActionButton[];
}

export interface ActionButton {
  text: string;
  value: string;
  type: 'primary' | 'default' | 'danger';
}
