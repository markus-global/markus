#!/usr/bin/env node
// Agent throughput/latency benchmark harness. Stub mode is network-free.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'benchmarks', 'agents');
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0);
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), count: s.length }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runBenchmark({ agents = 8, steps = 5, provider = 'stub' } = {}) {
  const task = [], tool = [], persist = []; let active = 0, peak = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: agents }, async () => {
    active++; peak = Math.max(peak, active);
    const start = performance.now();
    for (let i = 0; i < steps; i++) {
      let t = performance.now(); await sleep(1); tool.push(performance.now() - t);
      t = performance.now(); await sleep(1); persist.push(performance.now() - t);
    }
    task.push(performance.now() - start); active--;
  }));
  const elapsedMs = performance.now() - t0;
  return {
    provider, configuredConcurrency: agents, achievedConcurrency: peak, elapsedMs,
    throughput: { tasksPerMin: (agents / elapsedMs) * 60000, toolCallsPerMin: ((agents * steps) / elapsedMs) * 60000 },
    latencyMs: { task: stats(task), toolCall: stats(tool), persistence: stats(persist) },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  const provider = process.argv.includes('--provider=real') ? 'real' : 'stub';
  const r = await runBenchmark({ provider });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'latest.json'), JSON.stringify(r, null, 2));
  const basePath = join(OUT, 'baseline.json');
  const f = (n) => n.toFixed(2);
  console.log(`[bench:agents] provider=${r.provider} tasks/min=${f(r.throughput.tasksPerMin)} tool/min=${f(r.throughput.toolCallsPerMin)} concurrency=${r.achievedConcurrency}/${r.configuredConcurrency}`);
  for (const k of ['task', 'toolCall', 'persistence']) {
    const s = r.latencyMs[k];
    console.log(`  ${k} p50/p95/p99 = ${f(s.p50)}/${f(s.p95)}/${f(s.p99)} ms`);
  }
  if (!existsSync(basePath)) { writeFileSync(basePath, JSON.stringify(r, null, 2)); console.log('  wrote benchmarks/agents/baseline.json (commit it to enable comparisons)'); }
  else { const b = JSON.parse(readFileSync(basePath, 'utf8')); const d = ((r.throughput.tasksPerMin - b.throughput.tasksPerMin) / b.throughput.tasksPerMin) * 100; console.log(`  vs baseline: ${d >= 0 ? '+' : ''}${f(d)}% tasks/min`); }
})();
