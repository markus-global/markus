import { createLogger } from '@markus/shared';

const log = createLogger('slack-client');

export interface SlackClientConfig {
  // Slack Bot Token (starts with xoxb-)
  botToken: string;
  // Slack App Token (starts with xapp-)
  appToken?: string;
  // Signing Secret for verifying requests
  signingSecret: string;
  // Optional: Custom API endpoint
  apiUrl?: string;
  // Optional: Socket mode enabled
  socketMode?: boolean;
}

export interface SlackMessage {
  channel: string;
  text: string;
  blocks?: any[];
  attachments?: any[];
  thread_ts?: string;
  reply_broadcast?: boolean;
}

export interface SlackMessageResponse {
  ok: boolean;
  ts: string;
  channel: string;
  message?: {
    text: string;
    user: string;
    ts: string;
  };
  error?: string;
}

export class SlackClient {
  private config: SlackClientConfig;
  private botToken: string;
  private signingSecret: string;
  private apiUrl: string;

  constructor(config: SlackClientConfig) {
    this.config = config;
    this.botToken = config.botToken;
    this.signingSecret = config.signingSecret;
    this.apiUrl = config.apiUrl || 'https://slack.com/api';
    
    log.info('Slack client initialized');
  }

  /**
   * Send a text message to a Slack channel
   */
  async sendTextMessage(channelId: string, text: string, options?: {
    thread_ts?: string;
    reply_broadcast?: boolean;
  }): Promise<string> {
    try {
      const message: SlackMessage = {
        channel: channelId,
        text,
        thread_ts: options?.thread_ts,
        reply_broadcast: options?.reply_broadcast,
      };

      const response = await this.post('chat.postMessage', message);
      
      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack message sent to channel ${channelId}: ${response.ts}`);
      return response.ts;
    } catch (error) {
      log.error(`Failed to send Slack message to ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Send a message with blocks (rich formatting)
   */
  async sendBlocksMessage(channelId: string, blocks: any[], text?: string, options?: {
    thread_ts?: string;
  }): Promise<string> {
    try {
      const message: SlackMessage = {
        channel: channelId,
        text: text || 'Message with blocks',
        blocks,
        thread_ts: options?.thread_ts,
      };

      const response = await this.post('chat.postMessage', message);
      
      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack blocks message sent to channel ${channelId}: ${response.ts}`);
      return response.ts;
    } catch (error) {
      log.error(`Failed to send Slack blocks message to ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing message
   */
  async updateMessage(channelId: string, ts: string, text: string, blocks?: any[]): Promise<void> {
    try {
      const response = await this.post('chat.update', {
        channel: channelId,
        ts,
        text,
        blocks,
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack message updated in channel ${channelId}: ${ts}`);
    } catch (error) {
      log.error(`Failed to update Slack message ${ts} in ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(channelId: string, ts: string): Promise<void> {
    try {
      const response = await this.post('chat.delete', {
        channel: channelId,
        ts,
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack message deleted from channel ${channelId}: ${ts}`);
    } catch (error) {
      log.error(`Failed to delete Slack message ${ts} from ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Get channel information
   */
  async getChannelInfo(channelId: string): Promise<any> {
    try {
      const response = await this.post('conversations.info', {
        channel: channelId,
      });

      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      return response.channel;
    } catch (error) {
      log.error(`Failed to get channel info for ${channelId}:`, error);
      throw error;
    }
  }

  /**
   * Generic POST request to Slack API
   */
  private async post(endpoint: string, body: any): Promise<SlackMessageResponse> {
    const url = `${this.apiUrl}/${endpoint}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    return await response.json();
  }

  /**
   * Verify request signature (for webhook verification)
   */
  verifySignature(signature: string, timestamp: string, body: string): boolean {
    // TODO: Implement Slack signature verification
    // This requires creating a HMAC SHA256 signature using the signing secret
    // and comparing it with the provided signature
    log.warn('Slack signature verification not implemented');
    return true; // For development only
  }
}