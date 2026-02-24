import type { AgentToolHandler } from '../../agent.js';
import type { SkillManifest, SkillInstance } from '../types.js';

const manifest: SkillManifest = {
  name: 'feishu',
  version: '0.1.0',
  description: 'Feishu/Lark integration: messaging, documents, approvals',
  author: 'markus',
  category: 'communication',
  tags: ['feishu', 'lark', 'messaging', 'docs', 'approval'],
  tools: [
    {
      name: 'feishu_send_message',
      description: 'Send a text message to a Feishu chat',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Chat ID to send message to' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['chatId', 'text'],
      },
    },
    {
      name: 'feishu_send_card',
      description: 'Send an interactive card message to a Feishu chat',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Chat ID' },
          title: { type: 'string', description: 'Card title' },
          content: { type: 'string', description: 'Card content markdown text' },
          buttons: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                value: { type: 'string' },
              },
            },
            description: 'Optional action buttons',
          },
        },
        required: ['chatId', 'title', 'content'],
      },
    },
    {
      name: 'feishu_search_docs',
      description: 'Search for documents in Feishu workspace',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keyword' },
          count: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'feishu_read_doc',
      description: 'Read content of a Feishu document',
      inputSchema: {
        type: 'object',
        properties: {
          docToken: { type: 'string', description: 'Document token' },
          docType: { type: 'string', description: 'docx or sheet (default docx)' },
        },
        required: ['docToken'],
      },
    },
    {
      name: 'feishu_create_approval',
      description: 'Create an approval instance in Feishu',
      inputSchema: {
        type: 'object',
        properties: {
          approvalCode: { type: 'string', description: 'Approval definition code' },
          formContent: { type: 'string', description: 'JSON string of form fields' },
          targetUserId: { type: 'string', description: 'User ID of approver' },
        },
        required: ['approvalCode', 'formContent', 'targetUserId'],
      },
    },
    {
      name: 'feishu_approval_status',
      description: 'Check the status of an approval instance',
      inputSchema: {
        type: 'object',
        properties: {
          instanceCode: { type: 'string', description: 'Approval instance code' },
        },
        required: ['instanceCode'],
      },
    },
  ],
  requiredEnv: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  requiredPermissions: ['network'],
};

export function createFeishuSkill(): SkillInstance {
  const tools: AgentToolHandler[] = [
    {
      name: 'feishu_send_message',
      description: manifest.tools[0]!.description,
      inputSchema: manifest.tools[0]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const msgId = await client.sendTextMessage(args['chatId'] as string, args['text'] as string);
        return `Message sent: ${msgId}`;
      },
    },
    {
      name: 'feishu_send_card',
      description: manifest.tools[1]!.description,
      inputSchema: manifest.tools[1]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const buttons = (args['buttons'] as Array<{ text: string; value: string }>) ?? [];
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: args['title'] as string } },
          elements: [
            { tag: 'markdown', content: args['content'] as string },
            ...(buttons.length > 0 ? [{
              tag: 'action',
              actions: buttons.map(b => ({
                tag: 'button',
                text: { tag: 'plain_text', content: b.text },
                value: { action: b.value },
                type: 'primary',
              })),
            }] : []),
          ],
        };
        const msgId = await client.sendInteractiveMessage(args['chatId'] as string, card);
        return `Card sent: ${msgId}`;
      },
    },
    {
      name: 'feishu_search_docs',
      description: manifest.tools[2]!.description,
      inputSchema: manifest.tools[2]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const results = await client.searchDocs(args['query'] as string, (args['count'] as number) ?? 10);
        return JSON.stringify(results, null, 2);
      },
    },
    {
      name: 'feishu_read_doc',
      description: manifest.tools[3]!.description,
      inputSchema: manifest.tools[3]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const docContent = await client.getDocContent(
          args['docToken'] as string,
          (args['docType'] as 'docx' | 'sheet') ?? 'docx',
        );
        return docContent;
      },
    },
    {
      name: 'feishu_create_approval',
      description: manifest.tools[4]!.description,
      inputSchema: manifest.tools[4]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const code = await client.createApproval(
          args['approvalCode'] as string,
          args['formContent'] as string,
          args['targetUserId'] as string,
        );
        return `Approval created: ${code}`;
      },
    },
    {
      name: 'feishu_approval_status',
      description: manifest.tools[5]!.description,
      inputSchema: manifest.tools[5]!.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const { FeishuClient } = await import('@markus/comms');
        const client = new FeishuClient({
          appId: process.env['FEISHU_APP_ID'] ?? '',
          appSecret: process.env['FEISHU_APP_SECRET'] ?? '',
        });
        const status = await client.getApprovalStatus(args['instanceCode'] as string);
        return JSON.stringify(status, null, 2);
      },
    },
  ];

  return { manifest, tools };
}
