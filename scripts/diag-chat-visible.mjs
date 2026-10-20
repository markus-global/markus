#!/usr/bin/env node
/**
 * diag-chat-visible — locate "message is stored but the UI shows nothing" deterministically.
 *
 * Read-only. Every layer (DB / API / rendering) fails the same way from the user's seat —
 * as a missing body — so guessing from the UI cannot separate them. This script lays the
 * two server-side layers side by side and splits the candidate root causes with one test:
 *
 *   DB has body + API returns body   -> server read path is fine  => client render / virtualization
 *   DB has body + API returns empty  -> read, filter or serialization layer
 *   DB has no body                   -> write layer
 *   API 401/403                      -> auth/permission, NOT a data problem (never report it as one)
 *
 * Usage:
 *   node scripts/diag-chat-visible.mjs --session cs_xxx [--message cm_xxx]
 *        [--api http://127.0.0.1:8056] [--db ~/.markus/data.db] [--token <bearer>]
 *
 * Env: MARKUS_HOME (db location), MARKUS_API_URL, MARKUS_API_TOKEN.
 * Output: one JSON object on stdout (machine readable). Message bodies are never echoed —
 * only lengths and flags — so the output is safe to paste into a report.
 * Exit: 0 = layers agree, 1 = disagreement found, 2 = bad usage.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE =
  'usage: node scripts/diag-chat-visible.mjs --session <cs_id> [--message <cm_id>] ' +
  '[--api URL] [--db PATH] [--token <bearer>]';

const KNOWN = new Set(['session', 'message', 'api', 'db', 'token', 'help']);
const argv = process.argv.slice(2);

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!KNOWN.has(name)) throw new Error(`unknown flag: ${a}`);
    if (name === 'help') return { help: true };
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${a}`);
    out[name] = value;
    i++;
  }
  return out;
}

let opts;
try {
  opts = parseArgs(argv);
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const sessionId = opts.session;
if (!sessionId) {
  console.error(USAGE);
  process.exit(2);
}
const messageId = opts.message ?? null;
const apiBase = (opts.api ?? process.env.MARKUS_API_URL ?? 'http://127.0.0.1:8056').replace(/\/+$/, '');
const dbPath = opts.db ?? join(process.env.MARKUS_HOME ?? join(homedir(), '.markus'), 'data.db');
const token = opts.token ?? process.env.MARKUS_API_TOKEN ?? null;

/** Length and flags only — the body itself never leaves the process. */
function readDb(sid, mid) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sql =
      'SELECT id, role, created_at, length(trim(coalesce(content, \'\'))) AS text_len, metadata ' +
      'FROM chat_messages WHERE ' +
      (mid ? 'id = ?' : 'session_id = ? ORDER BY created_at DESC LIMIT 1');
    const row = db.prepare(sql).get(mid ?? sid);
    if (!row) return { found: false };
    let meta = null;
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : null;
    } catch {
      meta = null;
    }
    const segments = Array.isArray(meta?.segments) ? meta.segments : [];
    return {
      found: true,
      id: row.id,
      role: row.role,
      createdAt: row.created_at,
      textLen: row.text_len,
      nonEmpty: row.text_len > 0,
      segmentCount: segments.length,
      segmentTextLen: segments.reduce(
        (n, s) => n + (typeof s?.content === 'string' ? s.content.length : 0),
        0
      ),
      flags: {
        emptyReply: meta?.emptyReply ?? null,
        isError: meta?.isError ?? null,
        isStopped: meta?.isStopped ?? null,
      },
    };
  } finally {
    db.close();
  }
}

async function readApi(sid, mid) {
  const url = `${apiBase}/api/sessions/${encodeURIComponent(sid)}/messages/${encodeURIComponent(mid)}`;
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null; // non-JSON body: reported by status + bodyLen only
    }
    const content = parsed?.message?.content;
    return {
      url,
      status: res.status,
      ok: res.ok,
      bodyLen: body.length,
      contentLen: typeof content === 'string' ? content.length : null,
      nonEmpty: typeof content === 'string' ? content.trim().length > 0 : null,
      error: typeof parsed?.error === 'string' ? parsed.error : null,
    };
  } catch (err) {
    return { url, status: null, ok: false, error: String(err), nonEmpty: null, contentLen: null };
  }
}

const db = readDb(sessionId, messageId);
if (!db.found) {
  console.log(JSON.stringify({ verdict: 'db_missing', consistent: false, sessionId, messageId, db }, null, 2));
  process.exit(1);
}

const api = await readApi(sessionId, db.id);

/** Stable machine verdict + the human sentence that goes with it. */
const VERDICTS = {
  db_empty: 'DB has no body — stop looking at rendering; the write path is the suspect.',
  auth_rejected: 'API rejected the call — pass --token/MARKUS_API_TOKEN. Not a data defect.',
  api_unavailable: 'API did not answer — wrong port/process down. Not a data defect.',
  api_empty_but_db_has_content: 'DB has body, API returned none — read/filter/serialization layer.',
  server_read_ok: 'DB and API agree the body exists — suspect client render/virtualization.',
  api_ok_without_body: 'API answered 200 but without a content field — shape changed; check the contract.',
};

let verdict;
if (!db.nonEmpty) verdict = 'db_empty';
else if (api.status === 401 || api.status === 403) verdict = 'auth_rejected';
else if (!api.ok) verdict = 'api_unavailable';
else if (api.nonEmpty === true) verdict = 'server_read_ok';
else if (api.nonEmpty === false) verdict = 'api_empty_but_db_has_content';
else verdict = 'api_ok_without_body';

const consistent = verdict === 'server_read_ok';
console.log(
  JSON.stringify(
    { verdict, hint: VERDICTS[verdict], consistent, sessionId, messageId: db.id, db, api },
    null,
    2
  )
);
process.exit(consistent ? 0 : 1);
