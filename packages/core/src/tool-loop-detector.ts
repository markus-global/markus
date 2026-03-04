import { createLogger } from '@markus/shared';

const log = createLogger('tool-loop-detector');

export interface ToolCallRecord {
  name: string;
  argsHash: string;
  resultHash: string;
  timestamp: number;
}

export interface LoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  detectors: {
    genericRepeat: boolean;
    pingPong: boolean;
    noProgress: boolean;
  };
}

export interface LoopDetectionResult {
  detected: boolean;
  severity: 'none' | 'warning' | 'critical';
  pattern: string;
  message: string;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
  enabled: true,
  historySize: 30,
  warningThreshold: 5,
  criticalThreshold: 10,
  detectors: {
    genericRepeat: true,
    pingPong: true,
    noProgress: true,
  },
};

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Detects repetitive tool-call patterns that indicate no-progress loops.
 * Inspired by OpenClaw's loop-detection guardrails.
 */
export class ToolLoopDetector {
  private history: ToolCallRecord[] = [];
  private config: LoopDetectionConfig;

  constructor(config?: Partial<LoopDetectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  record(name: string, args: Record<string, unknown>, result: string): void {
    this.history.push({
      name,
      argsHash: hashString(JSON.stringify(args)),
      resultHash: hashString(result.slice(0, 1000)),
      timestamp: Date.now(),
    });

    if (this.history.length > this.config.historySize) {
      this.history = this.history.slice(-this.config.historySize);
    }
  }

  check(): LoopDetectionResult {
    if (!this.config.enabled || this.history.length < 3) {
      return { detected: false, severity: 'none', pattern: '', message: '' };
    }

    if (this.config.detectors.genericRepeat) {
      const result = this.detectGenericRepeat();
      if (result.detected) return result;
    }

    if (this.config.detectors.pingPong) {
      const result = this.detectPingPong();
      if (result.detected) return result;
    }

    if (this.config.detectors.noProgress) {
      const result = this.detectNoProgress();
      if (result.detected) return result;
    }

    return { detected: false, severity: 'none', pattern: '', message: '' };
  }

  /**
   * Detects: same tool + same args called repeatedly.
   * E.g., file_read("config.json") → file_read("config.json") → file_read("config.json")
   */
  private detectGenericRepeat(): LoopDetectionResult {
    const recent = this.history.slice(-this.config.criticalThreshold);
    if (recent.length < 3) return noDetection();

    // Count consecutive identical calls from the end
    const last = recent[recent.length - 1]!;
    let streak = 1;
    for (let i = recent.length - 2; i >= 0; i--) {
      const call = recent[i]!;
      if (call.name === last.name && call.argsHash === last.argsHash) {
        streak++;
      } else {
        break;
      }
    }

    if (streak >= this.config.criticalThreshold) {
      const msg = `Critical: "${last.name}" called ${streak} times with identical arguments`;
      log.warn(msg);
      return { detected: true, severity: 'critical', pattern: 'genericRepeat', message: msg };
    }

    if (streak >= this.config.warningThreshold) {
      const msg = `Warning: "${last.name}" called ${streak} times with identical arguments`;
      log.warn(msg);
      return { detected: true, severity: 'warning', pattern: 'genericRepeat', message: msg };
    }

    return noDetection();
  }

  /**
   * Detects: alternating A→B→A→B pattern.
   * E.g., file_edit → file_read → file_edit → file_read (trying the same fix repeatedly)
   */
  private detectPingPong(): LoopDetectionResult {
    const recent = this.history.slice(-this.config.criticalThreshold * 2);
    if (recent.length < 6) return noDetection();

    // Check for A-B alternation from the end
    const sig = (r: ToolCallRecord) => `${r.name}:${r.argsHash}`;
    const last = sig(recent[recent.length - 1]!);
    const prev = sig(recent[recent.length - 2]!);
    if (last === prev) return noDetection();

    let cycles = 0;
    for (let i = recent.length - 1; i >= 1; i -= 2) {
      if (sig(recent[i]!) === last && sig(recent[i - 1]!) === prev) {
        cycles++;
      } else {
        break;
      }
    }

    if (cycles >= Math.ceil(this.config.criticalThreshold / 2)) {
      const msg = `Critical: ping-pong pattern detected — "${recent[recent.length - 2]!.name}" ↔ "${recent[recent.length - 1]!.name}" for ${cycles} cycles`;
      log.warn(msg);
      return { detected: true, severity: 'critical', pattern: 'pingPong', message: msg };
    }

    if (cycles >= Math.ceil(this.config.warningThreshold / 2)) {
      const msg = `Warning: ping-pong pattern — "${recent[recent.length - 2]!.name}" ↔ "${recent[recent.length - 1]!.name}" for ${cycles} cycles`;
      log.warn(msg);
      return { detected: true, severity: 'warning', pattern: 'pingPong', message: msg };
    }

    return noDetection();
  }

  /**
   * Detects: tool calls producing identical results (no progress).
   * E.g., shell_execute("npm test") returning same failure 5 times in a row.
   */
  private detectNoProgress(): LoopDetectionResult {
    const recent = this.history.slice(-this.config.criticalThreshold);
    if (recent.length < 3) return noDetection();

    // Count identical results from the end
    const lastResult = recent[recent.length - 1]!.resultHash;
    let sameResultStreak = 1;
    for (let i = recent.length - 2; i >= 0; i--) {
      if (recent[i]!.resultHash === lastResult && recent[i]!.name === recent[recent.length - 1]!.name) {
        sameResultStreak++;
      } else {
        break;
      }
    }

    if (sameResultStreak >= this.config.criticalThreshold) {
      const msg = `Critical: "${recent[recent.length - 1]!.name}" returned identical results ${sameResultStreak} times — no progress`;
      log.warn(msg);
      return { detected: true, severity: 'critical', pattern: 'noProgress', message: msg };
    }

    if (sameResultStreak >= this.config.warningThreshold) {
      const msg = `Warning: "${recent[recent.length - 1]!.name}" returned identical results ${sameResultStreak} times`;
      log.warn(msg);
      return { detected: true, severity: 'warning', pattern: 'noProgress', message: msg };
    }

    return noDetection();
  }

  reset(): void {
    this.history = [];
  }

  getHistory(): readonly ToolCallRecord[] {
    return this.history;
  }
}

function noDetection(): LoopDetectionResult {
  return { detected: false, severity: 'none', pattern: '', message: '' };
}
