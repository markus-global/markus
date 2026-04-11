/**
 * Animated startup progress display for `markus start`.
 *
 * Displays a live ASCII progress bar + step list in the terminal while the
 * server is initialising.  Output is TTY-aware: non-interactive environments
 * fall back to simple unadorned text lines.
 *
 * Progress phases
 * ---------------
 * 0  → Boot
 * 1  → Config
 * 2  → LLM providers
 * 3  → Database
 * 4  → Services
 * 5  → Gateway
 * 6  → Ready (browser opens)
 */

import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setSuppressConsole } from './logger.js';

// ── ASCII banner ─────────────────────────────────────────────────────────────

const BANNER = [
  '   ███╗   ███╗ █████╗ ██████╗ ██╗  ██╗██╗   ██╗███████╗',
  '   ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝██║   ██║██╔════╝',
  '   ██╔████╔██║███████║██████╔╝█████╔╝ ██║   ██║███████╗',
  '   ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ██║   ██║╚════██║',
  '   ██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗╚██████╔╝███████║',
  '   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
].join('\n');

const BANNER_LINES = BANNER.split('\n');

// ── Spinner frames ────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ALT = ['◐', '◓', '◑', '◒'];

// ── Step definitions ───────────────────────────────────────────────────────────

export interface StartupStep {
  id: number;
  label: string;
  detail?: string;
}

export const STARTUP_STEPS: StartupStep[] = [
  { id: 0, label: 'Boot',           detail: 'markus CLI initialised' },
  { id: 1, label: 'Config',        detail: 'loading ~/.markus/markus.json' },
  { id: 2, label: 'LLM Providers', detail: 'routing & credential resolution' },
  { id: 3, label: 'Database',      detail: 'SQLite storage initialisation' },
  { id: 4, label: 'Services',      detail: 'agent manager, task service, API server' },
  { id: 5, label: 'Gateway',       detail: 'webhook adapters (Feishu, WebUI…)' },
  { id: 6, label: 'Ready',         detail: 'server listening' },
];

const TOTAL_STEPS = STARTUP_STEPS.length; // 7

// ── ANSI helpers ───────────────────────────────────────────────────────────────

function clearLine(): string {
  return '\r\x1b[K';
}

function clearScreen(): string {
  // \x1b[2J = erase entire screen, \x1b[H = move cursor to home (top-left)
  return '\x1b[2J\x1b[H';
}

function cursorHide(): string {
  return '\x1b[?25l';
}

function cursorShow(): string {
  return '\x1b[?25h';
}

function moveUp(n: number): string {
  return `\x1b[${n}A`;
}

function cyan(s: string): string  { return `\x1b[36m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string    { return `\x1b[31m${s}\x1b[0m`; }
function bold(s: string): string   { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string    { return `\x1b[2m${s}\x1b[0m`; }

// ── Progress bar renderer ──────────────────────────────────────────────────────

function renderProgressBar(current: number, total: number, width = 28): string {
  const filled = Math.round((current / total) * width);
  const empty  = width - filled;
  const bar    = '█'.repeat(filled) + '░'.repeat(empty);
  const pct    = Math.round((current / total) * 100);
  return `[${bar}] ${pct}%`;
}

// ── StartupProgress class ─────────────────────────────────────────────────────

export class StartupProgress {
  private steps: Array<{ label: string; detail: string; status: 'pending' | 'active' | 'done' | 'fail' | 'skip' }>;
  private currentStep = 0;
  private spinnerIdx  = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isTty       = false;
  private output     : NodeJS.WriteStream & { fd: 1 } | typeof process.stdout;
  private startedAt   = 0;
  private logPath     = '';

  constructor(logPath: string) {
    this.logPath = logPath;
    this.steps   = STARTUP_STEPS.map(s => ({ label: s.label, detail: s.detail ?? '', status: 'pending' }));
    this.output  = process.stdout;
    try {
      this.isTty = this.output.isTTY ?? false;
    } catch {
      this.isTty = false;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.startedAt = Date.now();
    if (this.isTty) {
      setSuppressConsole(true);
      this.render();
      this.intervalId = setInterval(() => this.tick(), 100);
    } else {
      // Non-TTY: print banner + step list without animation
      // (don't stay silent — users watching a blank screen is bad UX)
      this.printNonTtyBanner();
      this.printSteps();
    }
  }

  /** Mark the given step index as done. */
  complete(stepIdx: number, detail?: string): void {
    if (detail) this.steps[stepIdx].detail = detail;
    this.steps[stepIdx].status = 'done';
    if (stepIdx >= this.currentStep) {
      this.currentStep = stepIdx + 1;
    }
    this.writeLog('OK', stepIdx);
    if (!this.isTty) this.printNonTtyLine(stepIdx, 'done');
  }

  /** Mark the given step index as failed. */
  fail(stepIdx: number, detail?: string): void {
    if (detail) this.steps[stepIdx].detail = detail;
    this.steps[stepIdx].status = 'fail';
    if (stepIdx >= this.currentStep) {
      this.currentStep = stepIdx + 1;
    }
    this.writeLog('FAIL', stepIdx);
    if (!this.isTty) this.printNonTtyLine(stepIdx, 'fail');
  }

  /** Mark the given step index as skipped. */
  skip(stepIdx: number, detail?: string): void {
    if (detail) this.steps[stepIdx].detail = detail;
    this.steps[stepIdx].status = 'skip';
    this.writeLog('SKIP', stepIdx);
    if (!this.isTty) this.printNonTtyLine(stepIdx, 'skip');
  }

  /** Update the detail text of the currently-active step. */
  updateDetail(stepIdx: number, detail: string): void {
    this.steps[stepIdx].detail = detail;
    if (!this.isTty) this.printNonTtyLine(stepIdx, 'active');
  }

  /** Mark a step as active (spinner + bold label). */
  setActive(stepIdx: number): void {
    this.steps[stepIdx].status = 'active';
    this.currentStep = stepIdx;
    this.writeLog('INFO', stepIdx);
    if (!this.isTty) this.printNonTtyLine(stepIdx, 'active');
  }

  /** Stop the animation and print the final ready screen. */
  finish(url: string): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.steps[TOTAL_STEPS - 1].status = 'done';
    this.steps[TOTAL_STEPS - 1].detail  = url;

    if (this.isTty) {
      this.renderFinal(url);
    } else {
      this.printNonTtyFinal(url);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private tick(): void {
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
    this.render();
  }

  private write(content: string): void {
    try {
      this.output.write(content + '\n');
    } catch {
      // ignore
    }
  }

  private writeLog(type: 'OK' | 'FAIL' | 'SKIP' | 'INFO', stepIdx: number): void {
    const step = this.steps[stepIdx];
    const ts   = new Date().toISOString();
    const msg  = `[${type}] [${step.label}] ${step.detail || step.label}`;
    const line = `${ts} ${msg}\n`;
    try {
      const dir = join(homedir(), '.markus', 'logs');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
      appendFileSync(this.logPath, line, { mode: 0o644 });
    } catch {
      // non-fatal
    }
  }

  private render(): void {
    if (!this.isTty) return;

    const lines: string[] = [];
    const W = 60;

    // ── Banner ──
    lines.push('');
    for (const l of BANNER_LINES) {
      lines.push(`  ${cyan(l)}`);
    }
    lines.push('');

    // ── Progress bar ──
    const pct   = Math.round((this.currentStep / TOTAL_STEPS) * 100);
    const frame = SPINNER_FRAMES[this.spinnerIdx];
    lines.push(`  ${frame} ${bold('Starting Markus')}   ${dim(renderProgressBar(this.currentStep, TOTAL_STEPS))}`);
    lines.push('');

    // ── Step list ──
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      const isCurrent = i === this.currentStep;
      const icon = this.stepIcon(s.status, isCurrent);

      if (s.status === 'done') {
        lines.push(`  ${green('✓')}  ${green(s.label)}   ${dim(s.detail)}`);
      } else if (s.status === 'fail') {
        lines.push(`  ${red('✗')}  ${red(s.label)}   ${dim(s.detail)}`);
      } else if (s.status === 'skip') {
        lines.push(`  ${yellow('○')}  ${dim(s.label)}   ${dim(s.detail)}`);
      } else if (s.status === 'active') {
        const spin = SPINNER_FRAMES[this.spinnerIdx];
        lines.push(`  ${cyan(spin)} ${bold(s.label)}   ${dim(s.detail)}`);
      } else {
        lines.push(`    ${dim('○')}  ${s.label}   ${dim(s.detail)}`);
      }
    }

    lines.push('');
    lines.push(`  ${dim(`logs → ~/.markus/logs/`)}`);

    // ── Output ──
    const output = lines.join('\n');
    this.write(clearScreen() + cursorHide() + output);
  }

  private renderFinal(url: string): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    setSuppressConsole(false);

    const lines: string[] = [];
    lines.push('');
    for (const l of BANNER_LINES) {
      lines.push(`  ${cyan(l)}`);
    }
    lines.push('');
    lines.push(`  ${green('◉')}  ${bold('Markus is running')}   ${dim(`(${elapsed}s)`)}`);
    lines.push('');
    lines.push(`  ${bold('→')}  ${url}`);
    lines.push('');
    lines.push(`  ${dim('Press Ctrl+C to stop')}`);
    lines.push('');

    this.write(clearScreen() + cursorShow() + lines.join('\n'));
  }

  private printNonTtyBanner(): void {
    for (const l of BANNER_LINES) {
      this.write(`  ${l}`);
    }
    this.write('');
  }

  /** Print the full step list once (used by non-TTY start). */
  private printSteps(): void {
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      this.printNonTtyLine(i, s.status);
    }
  }

  /** Print a single progress line for non-TTY mode.
   *  Overwrites the current line so it stays visible but compact. */
  private printNonTtyLine(stepIdx: number, status: 'pending' | 'active' | 'done' | 'fail' | 'skip'): void {
    const s = this.steps[stepIdx];
    const label = s.label.padEnd(16);
    const detail = (s.detail || '').substring(0, 50);
    let line: string;
    if (status === 'done') {
      line = `  ✓  ${label} ${detail}`;
    } else if (status === 'fail') {
      line = `  ✗  ${label} ${detail}`;
    } else if (status === 'skip') {
      line = `  ○  ${label} ${detail}`;
    } else if (status === 'active') {
      // Cycle through a few spinner frames for active indication
      const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼'];
      const spin = spinFrames[stepIdx % spinFrames.length];
      line = `  ${spin} ${label} ${detail}`;
    } else {
      line = `    ${label} ${detail}`;
    }
    // Clear line then overwrite
    this.write(`\r\x1b[K${line}`);
  }

  private printNonTtyFinal(url: string): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.write(`\n  Markus is running (${elapsed}s) → ${url}`);
  }

  private stepIcon(
    status: 'pending' | 'active' | 'done' | 'fail' | 'skip',
    isCurrent: boolean,
  ): string {
    if (status === 'done')  return green('✓');
    if (status === 'fail')  return red('✗');
    if (status === 'skip')  return yellow('○');
    if (status === 'active') return SPINNER_FRAMES[this.spinnerIdx];
    return dim('○');
  }
}
