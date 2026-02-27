import { createLogger } from '@markus/shared';

const log = createLogger('whatsapp-client');

export interface WhatsAppClientConfig {
  // WhatsApp Business API credentials
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  // API configuration
  apiVersion?: string;
  baseUrl?: string;
}

interface WhatsAppMessageResponse {
  messaging_product: 'whatsapp';
  contacts?: Array<{
    input: string;
    wa_id: string;
  }>;
  messages?: Array<{
    id: string;
  }>;
}

export class WhatsAppClient {
  private config: WhatsAppClientConfig;
  private baseUrl: string;

  constructor(config: WhatsAppClientConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? 'https://graph.facebook.com';
    if (config.apiVersion) {
      this.baseUrl = `${this.baseUrl}/${config.apiVersion}`;
    } else {
      this.baseUrl = `${this.baseUrl}/v18.0`; // Default to v18.0
    }
  }

  async sendTextMessage(to: string, text: string): Promise<string> {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WhatsApp API error: ${response.status} ${response.statusText} - ${error}`);
    }

    const data = await response.json() as WhatsAppMessageResponse;
    
    if (data.messages && data.messages.length > 0) {
      return data.messages[0].id;
    }
    
    throw new Error('No message ID returned from WhatsApp API');
  }

  async sendTemplateMessage(to: string, templateName: string, languageCode: string = 'en_US'): Promise<string> {
    const url = `${this.baseUrl}/${this.config.phoneNumberId}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WhatsApp API error: ${response.status} ${response.statusText} - ${error}`);
    }

    const data = await response.json() as WhatsAppMessageResponse;
    
    if (data.messages && data.messages.length > 0) {
      return data.messages[0].id;
    }
    
    throw new Error('No message ID returned from WhatsApp API');
  }

  // TODO: Implement webhook verification
  // TODO: Implement message status checking
  // TODO: Implement media message sending
  // TODO: Implement conversation management
}