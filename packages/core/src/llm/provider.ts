import type { LLMRequest, LLMResponse, LLMStreamEvent, LLMProviderConfig, ProviderCapabilities } from '@markus/shared';

export interface LLMProviderInterface {
  readonly name: string;
  readonly model: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  chatStream?(request: LLMRequest, onEvent: (event: LLMStreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse>;
  configure(config: LLMProviderConfig): void;
}

// ---------------------------------------------------------------------------
// Multi-modal provider interfaces
// ---------------------------------------------------------------------------

export interface ImageGenOptions {
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
  negative_prompt?: string;
  seed?: number;
  output_dir?: string;
  output_format?: string;
}

export interface ImageResult {
  url?: string;
  base64?: string;
  revisedPrompt?: string;
}

export interface TTSOptions {
  model?: string;
  voice?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';
}

export interface AudioResult {
  audio: Buffer;
  format: string;
  durationMs?: number;
}

export interface STTOptions {
  model?: string;
  language?: string;
  prompt?: string;
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt';
}

export interface VideoGenOptions {
  model?: string;
  duration?: number;
  size?: string;
  fps?: number;
}

export interface VideoResult {
  url?: string;
  taskId?: string;
  status: 'completed' | 'processing' | 'failed';
  durationSeconds?: number;
}

/**
 * Extended provider interface supporting multi-modal operations.
 * All methods are optional -- providers declare which modalities they support
 * via getCapabilities().
 */
export interface ToolParamSchema {
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MultiModalToolSchemas {
  generate_image?: ToolParamSchema;
  text_to_speech?: ToolParamSchema;
  speech_to_text?: ToolParamSchema;
  generate_video?: ToolParamSchema;
}

export interface MultiModalProviderInterface extends LLMProviderInterface {
  getCapabilities?(): ProviderCapabilities;
  getToolSchemas?(): MultiModalToolSchemas;
  generateImage?(prompt: string, options?: ImageGenOptions): Promise<ImageResult[]>;
  generateSpeech?(text: string, options?: TTSOptions): Promise<AudioResult>;
  transcribeSpeech?(audio: Buffer, options?: STTOptions): Promise<string>;
  generateVideo?(prompt: string, options?: VideoGenOptions): Promise<VideoResult>;
}
