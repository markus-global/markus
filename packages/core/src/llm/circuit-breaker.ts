import { createLogger } from '@markus/shared';

const log = createLogger('circuit-breaker');

/**
 * Circuit Breaker states following the classic pattern:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failure threshold exceeded, requests are rejected immediately
 * - HALF_OPEN: After cooling period, allow a test request through
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of consecutive successes in HALF_OPEN to close the circuit (default: 3) */
  successThreshold?: number;
  /** Milliseconds before attempting recovery from OPEN → HALF_OPEN (default: 60s) */
  resetTimeoutMs?: number;
  /** Request timeout in ms for all calls protected by this breaker (default: 30s) */
  timeoutMs?: number;
  /** Unique name for logging and identification */
  name?: string;
}

/**
 * Circuit Breaker implementation for resilient LLM provider calls.
 *
 * State machine:
 * ```
 * CLOSED ──(failureThreshold exceeded)──→ OPEN
 *   ▲                                    │
 *   │                              (resetTimeoutMs elapsed)
 *   │                                    ↓
 *   │    (successThreshold successes) ← HALF_OPEN
 *   │                                    │
 *   │               (1 failure)          │
 *   └────────────────────────────────────┘
 * ```
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly name: string;

  private state = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  private openedAt = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? 'default';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  getState(): CircuitState {
    return this.state;
  }

  getStats(): {
    state: CircuitState;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    lastFailureAt: number;
    lastSuccessAt: number;
    openedAt: number;
    name: string;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      openedAt: this.openedAt,
      name: this.name,
    };
  }

  /** Check if a request is allowed to proceed */
  canExecute(): boolean {
    if (this.state === CircuitState.CLOSED) return true;

    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
        log.info(`[${this.name}] Circuit HALF_OPEN — allowing test request`);
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow one test request through
    return true;
  }

  /**
   * Execute a function through the circuit breaker.
   * Returns a degraded response object on circuit open, or throws on failure.
   *
   * @param fn Async function to execute
   * @returns Result of fn, or a degraded response object if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new CircuitOpenError(`[${this.name}] Circuit breaker is OPEN — request rejected`, this.name, this.state);
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      const _id = setTimeout(() => reject(new CircuitTimeoutError(`[${this.name}] Request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      // Allow abort
      if (typeof AbortSignal !== 'undefined') {
        // no-op: caller should pass AbortSignal separately
      }
    });

    try {
      const result = await Promise.race([
        fn(),
        timeoutPromise,
      ]);
      this.recordSuccess();
      return result as T;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  /**
   * Record a successful execution.
   * Called by execute() automatically, but can also be called manually.
   */
  recordSuccess(): void {
    const now = Date.now();
    this.lastSuccessAt = now;
    this.consecutiveFailures = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }
  }

  /**
   * Record a failed execution.
   * Called by execute() automatically, but can also be called manually.
   */
  recordFailure(_error?: unknown): void {
    const now = Date.now();
    this.lastFailureAt = now;
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN immediately re-opens the circuit
      log.warn(`[${this.name}] HALF_OPEN: failure during recovery attempt — re-opening circuit`);
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold && this.state === CircuitState.CLOSED) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  /**
   * Manually reset the circuit breaker to CLOSED state.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
    this.openedAt = 0;
    this.transitionTo(CircuitState.CLOSED);
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;

    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now();
      this.consecutiveFailures = 0;
    }

    log.info(`[${this.name}] Circuit state: ${oldState} → ${newState}`);
  }
}

/** Thrown when the circuit is open and no request can proceed */
export class CircuitOpenError extends Error {
  readonly circuitName: string;
  readonly circuitState: CircuitState;

  constructor(message: string, circuitName: string, circuitState: CircuitState) {
    super(message);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
    this.circuitState = circuitState;
  }
}

/** Thrown when a request times out */
export class CircuitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitTimeoutError';
  }
}
