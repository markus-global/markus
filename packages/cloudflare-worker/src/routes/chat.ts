/**
 * LLM Chat Completions proxy endpoint.
 *
 * POST /v1/chat/completions
 *
 * This skeleton validates the request body shape and returns a stub
 * response.  The actual upstream forwarding will be implemented in a
 * later phase (Wave 2 — LLM Router).
 */

import { badRequest } from '../utils/errors.js';
import { badRequest as badRequestResponse, json } from '../utils/response.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

interface ChatResponse {
  id: string;
  model: string;
  object: 'chat.completion';
  created: number;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length';
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleChat(request: Request): Promise<Response> {
  // Validate method
  if (request.method !== 'POST') {
    return badRequestResponse(badRequest('Only POST is allowed for /v1/chat/completions'));
  }

  // Parse and validate body
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return badRequestResponse(badRequest('Invalid JSON body'));
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequestResponse(badRequest('messages array is required and must be non-empty'));
  }

  if (!body.model) {
    return badRequestResponse(badRequest('model field is required'));
  }

  // TODO(Wave 2): Forward to upstream LLM provider via LLM Router + deduct quota.
  // For now, return a stub response.
  const stubResponse: ChatResponse = {
    id: crypto.randomUUID(),
    model: body.model,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `[proxy-stub] Received your message (model=${body.model}, messages=${body.messages.length}). Forwarding will be implemented in Wave 2.`,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return json(stubResponse);
}
