// ─── Coding Tool Integration Types ───────────────────────────────────────────
//
// Type contracts for the external coding tool integration system.
// Phase 0 specs — interfaces only, no implementation.

import type { Task, TaskStatus, TaskPriority } from './task.js';
import type { TaskDeliverable } from './governance.js';

// ─── Tool Identity ───────────────────────────────────────────────────────────

export type CodingToolName = 'claude-code' | 'codex' | 'cursor-agent';

export interface CodingToolInfo {
  name: CodingToolName;
  displayName: string;
  binaryName: string;
  version?: string;
  path?: string;
  available: boolean;
  installHint?: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface CodingToolConfig {
  tool: CodingToolName;
  enabled: boolean;
  binaryPath?: string;
  defaultArgs?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  /** Per-task env vars to inject (e.g. CODEX_HOME) */
  env?: Record<string, string>;
  /** Default model; used when agent doesn't specify one per invocation */
  defaultModel?: string;
  /** Hard per-session budget cap in USD (only Claude Code enforces via --max-budget-usd) */
  maxBudgetPerSessionUsd?: number;
  /** When true, handler refuses execution until agent gets user approval */
  approvalRequired?: boolean;
}

// ─── Session Lifecycle ───────────────────────────────────────────────────────

export type CodingToolSessionStatus =
  | 'created'
  | 'context_injected'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface CodingToolSession {
  id: string;
  taskId: string;
  tool: CodingToolName;
  status: CodingToolSessionStatus;
  worktreePath?: string;
  /** Branch name for the worktree */
  branchName?: string;
  /** The prompt/instruction sent to the coding tool */
  prompt: string;
  /** Structured result from the tool (populated on completion) */
  result?: CodingToolResult;
  /** Cost report (best-effort, not all tools expose this) */
  cost?: ToolCostReport;
  /** Progress percentage (0-100), updated during execution */
  progressPercent?: number;
  /** Most recent progress message */
  progressMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Execution Result ────────────────────────────────────────────────────────

export interface CodingToolResult {
  success: boolean;
  /** Summary of what the tool did */
  summary: string;
  /** Git diff stats from the worktree */
  diffStats?: { filesChanged: number; additions: number; deletions: number };
  /** Files modified/created in the worktree */
  modifiedFiles?: string[];
  /** Test results if QualityVerifier ran */
  testResult?: TestResult;
  /** Raw tool output (truncated if too large) */
  rawOutput?: string;
  /** Error message on failure */
  error?: string;
  /** Exit code from the tool CLI */
  exitCode?: number;
}

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  /** Whether all tests passed */
  success: boolean;
  /** Raw test runner output (truncated) */
  output?: string;
}

// ─── Cost Tracking ───────────────────────────────────────────────────────────

export interface ToolCostReport {
  /** Input tokens consumed */
  inputTokens?: number;
  /** Output tokens consumed */
  outputTokens?: number;
  /** Cache read tokens (if applicable) */
  cacheReadTokens?: number;
  /** Cache write tokens (if applicable) */
  cacheWriteTokens?: number;
  /** Estimated cost in USD (best-effort) */
  estimatedCostUsd?: number;
  /** Duration of the tool execution in ms */
  durationMs?: number;
  /** Source of cost data: 'tool_output' | 'api_response' | 'estimated' */
  source?: 'tool_output' | 'api_response' | 'estimated';
}

// ─── Progress Events ─────────────────────────────────────────────────────────

export type CodingToolEventType =
  | 'progress'
  | 'tool_use'
  | 'file_edit'
  | 'test_run'
  | 'error'
  | 'cost_update'
  | 'completed';

export interface CodingToolEvent {
  type: CodingToolEventType;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// ─── Tool Adapter Interface ──────────────────────────────────────────────────

export interface ToolAdapterDetectResult {
  available: boolean;
  version?: string;
  path?: string;
  installHint?: string;
  /** Whether the tool is authenticated and ready to use */
  authenticated?: boolean;
  /** Hint for how to authenticate if not authenticated */
  authHint?: string;
  /** Authenticated user/account info */
  authUser?: string;
}

export interface ToolAdapterBuildArgsResult {
  args: string[];
  env: Record<string, string>;
}

/** A model available to a coding tool */
export interface ToolAdapterModel {
  /** Model identifier passed to the CLI (e.g. "claude-sonnet-4-6", "gpt-5-codex") */
  id: string;
  /** Human-readable display name (e.g. "Claude Sonnet 4.6") */
  name: string;
  /** Whether this is the tool's default model */
  isDefault?: boolean;
}

/** Result of listing models, includes provenance info */
export interface ToolAdapterModelsResult {
  models: ToolAdapterModel[];
  /** Where the model list came from */
  source: 'api' | 'cli' | 'static';
  /** Optional hint for the user (e.g. how to get more models) */
  hint?: string;
}

/** Extended build options that include per-invocation overrides */
export interface ToolAdapterBuildOpts {
  prompt: string;
  workdir: string;
  config?: CodingToolConfig;
  /** Per-invocation model override (takes precedence over config.defaultModel) */
  model?: string;
  /** Per-invocation mode override (tool-specific: plan/ask for Cursor, plan/auto for Claude Code) */
  mode?: string;
  /** Per-invocation effort override (Claude Code: low/medium/high; Codex: reasoning effort) */
  effort?: string;
  /** Per-session budget cap in USD (only Claude Code uses --max-budget-usd) */
  maxBudgetUsd?: number;
}

export interface ToolAdapter {
  readonly name: CodingToolName;
  readonly displayName: string;
  readonly binaryName: string;

  /** Detect if the tool CLI is available on the system */
  detect(): Promise<ToolAdapterDetectResult>;

  /** Build CLI arguments for a coding task */
  buildArgs(opts: ToolAdapterBuildOpts): ToolAdapterBuildArgsResult;

  /** List available models with source metadata. */
  listModels(): Promise<ToolAdapterModelsResult>;

  /** Parse streaming stdout output into structured events */
  parseOutput(line: string): CodingToolEvent | null;

  /** Extract cost report from completed output */
  extractCost(output: string): ToolCostReport | null;
}

// ─── Tool Execution Context (for AgentToolHandler) ───────────────────────────

export interface ToolExecutionContext {
  taskId?: string;
  sessionId?: string;
  /** Report structured progress events during tool execution */
  onProgress?: (event: CodingToolEvent) => void;
}

// ─── Task Context Response (GET /api/tasks/:id/context) ──────────────────────

export interface TaskContextResponse {
  task: {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    subtasks: Array<{ id: string; title: string; status: string }>;
    notes?: string[];
    deliverables?: TaskDeliverable[];
    completionSummary?: string;
    assignedAgentId: string;
    reviewerId: string;
    executionRound: number;
    createdAt: string;
    updatedAt: string;
  };
  requirement?: {
    id: string;
    title: string;
    description: string;
    status: string;
  };
  project?: {
    id: string;
    name: string;
    description: string;
    repositories: Array<{ url?: string; localPath?: string; role?: string }>;
  };
  upstream: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    notes?: string[];
    completionSummary?: string;
    deliverables?: TaskDeliverable[];
  }>;
  downstream: Array<{
    id: string;
    title: string;
    status: TaskStatus;
  }>;
}

// ─── CLI Output Contract ─────────────────────────────────────────────────────

export interface CliSuccessResponse<T = unknown> {
  ok: true;
  data: T;
}

export interface CliErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export type CliResponse<T = unknown> = CliSuccessResponse<T> | CliErrorResponse;

/** Exit code contract for CLI commands */
export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  SERVER_ERROR: 2,
  NETWORK_ERROR: 3,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

// ─── Type Guards ─────────────────────────────────────────────────────────────

export function isCodingToolName(value: unknown): value is CodingToolName {
  return typeof value === 'string' && ['claude-code', 'codex', 'cursor-agent'].includes(value);
}

export function isCodingToolSessionStatus(value: unknown): value is CodingToolSessionStatus {
  return (
    typeof value === 'string' &&
    ['created', 'context_injected', 'running', 'completed', 'failed', 'cancelled', 'timeout'].includes(value)
  );
}

export function isCodingToolEventType(value: unknown): value is CodingToolEventType {
  return (
    typeof value === 'string' &&
    ['progress', 'tool_use', 'file_edit', 'test_run', 'error', 'cost_update', 'completed'].includes(value)
  );
}

export function isCliSuccessResponse<T>(response: CliResponse<T>): response is CliSuccessResponse<T> {
  return response.ok === true;
}

export function isCliErrorResponse<T>(response: CliResponse<T>): response is CliErrorResponse {
  return response.ok === false;
}
