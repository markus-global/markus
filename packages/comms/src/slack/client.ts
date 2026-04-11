import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

export interface SlackMessage extends Record<string, unknown> {
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

// Slack event types
export interface SlackEventEnvelope {
  type: string;
  token?: string;
  team_id?: string;
  event?: SlackEvent;
  challenge?: string;
}

export interface SlackEvent {
  type: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  message?: SlackEvent;
  bot_id?: string;
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
   * Verify Slack request signature using HMAC-SHA256
   * Follows Slack's signing secret verification protocol:
   * 1. Concatenate version, timestamp, body
   * 2. HMAC-SHA256 with signing secret
   * 3. Compare using timing-safe comparison
   */
  verifySignature(signature: string, timestamp: string, body: string): boolean {
    if (!this.signingSecret) {
      log.warn('Slack signature verification skipped: no signing secret configured');
      return true;
    }

    // Slack rejects requests older than 5 minutes to prevent replay attacks
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 5 * 60;
    if (parseInt(timestamp, 10) < fiveMinutesAgo) {
      log.warn('Slack signature verification failed: request timestamp too old');
      return false;
    }

    const base = `v0:${timestamp}:${body}`;
    const mySignature = 'v0=' + createHmac('sha256', this.signingSecret)
      .update(base)
      .digest('hex');

    try {
      const sigBuffer = Buffer.from(signature);
      const mySigBuffer = Buffer.from(mySignature);
      if (sigBuffer.length !== mySigBuffer.length) return false;
      return timingSafeEqual(sigBuffer, mySigBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Send a text message to a Slack channel
   */
  async sendTextMessage(channelId: string, text: string, options?: Record<string, unknown>): Promise<string> {
    try {
      const message: Record<string, unknown> = {
        channel: channelId,
        text,
      };
      
      // Add optional fields if they exist
      if (options?.thread_ts) message.thread_ts = options.thread_ts;
      if (options?.reply_broadcast !== undefined) message.reply_broadcast = options.reply_broadcast;

      const response = await this.post('chat.postMessage', message);
      
      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack message sent to channel ${channelId}: ${response.ts}`);
      return response.ts;
    } catch (error) {
      log.error(`Failed to send Slack message to ${channelId}:`, { error });
      throw error;
    }
  }

  /**
   * Send a message with blocks (rich formatting)
   */
  async sendBlocksMessage(channelId: string, blocks: any[], text?: string, options?: Record<string, unknown>): Promise<string> {
    try {
      const message: Record<string, unknown> = {
        channel: channelId,
        text: text || 'Message with blocks',
        blocks,
      };
      
      // Add optional fields if they exist
      if (options?.thread_ts) message.thread_ts = options.thread_ts;

      const response = await this.post('chat.postMessage', message);
      
      if (!response.ok) {
        throw new Error(`Slack API error: ${response.error}`);
      }

      log.info(`Slack blocks message sent to channel ${channelId}: ${response.ts}`);
      return response.ts;
    } catch (error) {
      log.error(`Failed to send Slack blocks message to ${channelId}:`, { error });
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
      log.error(`Failed to update Slack message ${ts} in ${channelId}:`, { error });
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
      log.error(`Failed to delete Slack message ${ts} from ${channelId}:`, { error });
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
      log.error(`Failed to get channel info for ${channelId}:`, { error });
      throw error;
    }
  }

  /**
   * Generic POST request to Slack API
   */
  private async post(endpoint: string, body: Record<string, unknown>): Promise<SlackMessageResponse> {
    const url = `${this.apiUrl}/${endpoint}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    const result = await response.json() as SlackMessageResponse;
    return result;
  }

  // verifySignature is now defined inline above
}