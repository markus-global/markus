#!/usr/bin/env node
/**
 * diag-chat-visible — "消息已落库但界面看不到" 的确定性定位工具（只读）。
 *
 * 为什么需要它：DB、API、渲染三层里任一层出问题都表现为「看不到正文」。
 * 只看 UI 无法区分。本脚本把三层摊开对账，用一条判据分裂候选根因：
 *
 *   DB 有正文 + API 返回有正文  ⇒ 服务端读路径正常 ⇒ 客户端渲染/虚拟化（#1）
 *   DB 有正文 + API 返回空/404  ⇒ 服务端读取、过滤或权限层
 *   DB 无正文                  ⇒ 落库层
 *
 * 用法：
 *   node scripts/diag-chat-visible.mjs --session cs_xxx [--message cm_xxx]
 *        [--api http://127.0.0.1:8056] [--db ~/.markus/data.db]
 * 输出：单个 JSON（机器可读），exit 0 = 三层一致，exit 1 = 检出不一致。
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const sessionId = arg('session');
const messageId = arg('message');
const api = arg('api', 'http://127.0.0.1:8056').replace(/\/$/, '');
const dbPath = arg('db', join(homedir(), '.markus', 'data.db'));

if (!sessionId) {
  console.error('usage: --session <cs_id> [--message <cm_id>] [--api URL] [--db PATH]');
  process.exit(2);
}

function readDb() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = messageId
      ? db.prepare('SELECT id, role, length(content) AS len, content, metadata, created_at FROM chat_messages WHERE id = ?').get(messageId)
      : db.prepare('SELECT id, role, length(content) AS len, content, metadata, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
    if (!row) return { found: false };
    let meta = null;
    try { meta = row.metadata ? JSON.parse(row.metadata) : null; } catch { meta = null; }
    const segTextLen = Array.isArray(meta?.segments)
      ? meta.segments.reduce((n, s) => n + (typeof s?.content === 'string' ? s.content.length : 0), 0)
      : 0;
    return {
      found: true,
      id: row.id,
      role: row.role,
      contentLen: row.len,
      contentNonEmpty: (row.content ?? '').trim().length > 0,
      createdAt: row.created_at,
      segmentCount: Array.isArray(meta?.segments) ? meta.segments.length : 0,
      segmentTextLen: segTextLen,
      flags: {
        emptyReply: meta?.emptyReply ?? null,
        isError: meta?.isError ?? null,
        isStopped: meta?.isStopped ?? null,
        isStreaming: meta?.isStreaming ?? null,
      },
    };
  } finally {
    db.close();
  }
}

async function readApi(id) {
  const url = `${api}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url);
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
    const content = parsed?.content ?? parsed?.message?.content ?? null;
    return {
      url,
      status: res.status,
      ok: res.ok,
      contentLen: typeof content === 'string' ? content.length : null,
      contentNonEmpty: typeof content === 'string' ? content.trim().length > 0 : null,
      rawHead: body.slice(0, 160),
    };
  } catch (err) {
    return { url, status: null, ok: false, error: String(err), contentNonEmpty: null, contentLen: null };
  }
}

const db = readDb();
if (!db.found) {
  console.log(JSON.stringify({ verdict: 'DB_NO_SUCH_MESSAGE', sessionId, messageId, db }, null, 2));
  process.exit(1);
}

const apiRes = await readApi(db.id);
let verdict;
if (!db.contentNonEmpty) {
  verdict = 'DB_EMPTY (落库层)';
} else if (apiRes.contentNonEmpty === true) {
  verdict = 'SERVER_READ_OK (服务端读路径正常 ⇒ 客户端渲染/虚拟化)';
} else if (apiRes.ok) {
  verdict = 'API_RETURNS_EMPTY_BUT_DB_HAS_CONTENT (服务端读取/过滤/序列化层)';
} else {
  verdict = `API_NOT_OK status=${apiRes.status} (端点/权限/部署层)`;
}

const consistent = db.contentNonEmpty === (apiRes.contentNonEmpty === true);
console.log(JSON.stringify({ verdict, consistent, sessionId, messageId: db.id, db, api: apiRes }, null, 2));
process.exit(consistent ? 0 : 1);
