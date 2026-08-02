import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FeishuClient, type ReceiveIdType } from '@markus/comms';
import { createLogger } from '@markus/shared';
import type { AgentToolHandler } from '../agent.js';
import { toolErr, toolOk } from './result.js';

const log = createLogger('feishu-tools');

export interface FeishuToolsConfig {
  appId: string;
  appSecret: string;
  domain?: string;
  /** Default chat_id for group notifications when the agent omits receive_id */
  defaultChatId?: string;
  /** Default open_id for p2p ("send to my Feishu") when the agent omits receive_id */
  defaultOpenId?: string;
}

const RECEIVE_ID_TYPES: ReceiveIdType[] = ['chat_id', 'open_id', 'user_id', 'union_id'];

function resolveReceiveTarget(
  args: Record<string, unknown>,
  cfg: FeishuToolsConfig,
): { receiveId: string; idType: ReceiveIdType } | { error: string } {
  const receiveId = typeof args['receive_id'] === 'string' ? args['receive_id'].trim() : '';
  const rawType = typeof args['receive_id_type'] === 'string' ? args['receive_id_type'].trim() : '';
  const idType = (RECEIVE_ID_TYPES.includes(rawType as ReceiveIdType) ? rawType : '') as ReceiveIdType | '';

  if (receiveId) {
    return { receiveId, idType: idType || 'chat_id' };
  }
  if (cfg.defaultOpenId) {
    return { receiveId: cfg.defaultOpenId, idType: 'open_id' };
  }
  if (cfg.defaultChatId) {
    return { receiveId: cfg.defaultChatId, idType: 'chat_id' };
  }
  return {
    error:
      'Missing receive_id. Pass receive_id + receive_id_type (chat_id|open_id), or configure a Feishu notification target / open_id in Settings → Feishu.',
  };
}

export function createFeishuTools(cfg: FeishuToolsConfig): AgentToolHandler[] {
  const client = new FeishuClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.domain,
  });

  return [
    {
      name: 'feishu_send_message',
      description:
        'Send a text message to Feishu (Lark). Prefer this for plain text. ' +
        'When the user says "send to my Feishu" and chat_list is empty, use receive_id_type=open_id ' +
        '(resolve via feishu-lark__calendar_v4_calendar_primary or contact APIs). ' +
        'If Settings has a default notify target, receive_id can be omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
          receive_id: {
            type: 'string',
            description: 'Feishu chat_id or open_id (optional if a default target is configured)',
          },
          receive_id_type: {
            type: 'string',
            enum: RECEIVE_ID_TYPES,
            description: 'ID type for receive_id. Default: chat_id (or open_id when using the default open_id).',
          },
        },
        required: ['text'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const text = typeof args['text'] === 'string' ? args['text'] : '';
        if (!text.trim()) return toolErr('text is required');
        const target = resolveReceiveTarget(args, cfg);
        if ('error' in target) return toolErr(target.error);
        try {
          const messageId = await client.sendTextMessage(target.receiveId, text, target.idType);
          log.info('feishu_send_message ok', { messageId, idType: target.idType });
          return toolOk({ status: 'sent', message_id: messageId, receive_id_type: target.idType });
        } catch (err) {
          return toolErr(`Feishu send failed: ${String(err)}`);
        }
      },
    },
    {
      name: 'feishu_send_image',
      description:
        'Upload a local image file and send it as a Feishu IM image message. ' +
        'Use this for generated images under ~/.markus/generated/images/ — Feishu MCP cannot upload images. ' +
        'When the user says "send this image to my Feishu", prefer receive_id_type=open_id if no group chat_id is known.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to a local image file (png/jpg/webp/gif)',
          },
          receive_id: {
            type: 'string',
            description: 'Feishu chat_id or open_id (optional if a default target is configured)',
          },
          receive_id_type: {
            type: 'string',
            enum: RECEIVE_ID_TYPES,
            description: 'ID type for receive_id. Default: chat_id (or open_id when using the default open_id).',
          },
        },
        required: ['file_path'],
      },
      async execute(args: Record<string, unknown>): Promise<string> {
        const filePathRaw = typeof args['file_path'] === 'string' ? args['file_path'].trim() : '';
        if (!filePathRaw) return toolErr('file_path is required');
        const filePath = resolve(filePathRaw);
        try {
          await access(filePath);
        } catch {
          return toolErr(`Image file not found: ${filePath}`);
        }
        const target = resolveReceiveTarget(args, cfg);
        if ('error' in target) return toolErr(target.error);
        try {
          const messageId = await client.sendLocalImage(target.receiveId, filePath, target.idType);
          log.info('feishu_send_image ok', { messageId, filePath, idType: target.idType });
          return toolOk({ status: 'sent', message_id: messageId, file_path: filePath, receive_id_type: target.idType });
        } catch (err) {
          return toolErr(`Feishu image send failed: ${String(err)}`);
        }
      },
    },
  ];
}
