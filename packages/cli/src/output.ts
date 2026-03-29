/**
 * Output formatting for CLI commands.
 * Supports --json for machine-readable output and table/list for humans.
 */

export interface OutputOptions {
  json?: boolean;
}

let _globalJson = false;

export function setGlobalJson(json: boolean) {
  _globalJson = json;
}

function isJson(opts?: OutputOptions): boolean {
  return opts?.json ?? _globalJson;
}

/** Print data as JSON or formatted table */
export function table(
  rows: Record<string, unknown>[],
  columns: { key: string; header: string; width?: number }[],
  opts?: OutputOptions & { title?: string },
) {
  if (isJson(opts)) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (opts?.title) {
    console.log(`\n${opts.title}`);
    console.log('─'.repeat(70));
  }

  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }

  const widths = columns.map(c => c.width ?? Math.max(c.header.length, ...rows.map(r => String(r[c.key] ?? '').length)));
  const capped = widths.map(w => Math.min(w, 40));

  console.log('  ' + columns.map((c, i) => c.header.padEnd(capped[i]!)).join('  '));
  console.log('  ' + capped.map(w => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    const line = columns.map((c, i) => {
      const val = String(row[c.key] ?? '');
      return val.length > capped[i]! ? val.slice(0, capped[i]! - 1) + '…' : val.padEnd(capped[i]!);
    }).join('  ');
    console.log('  ' + line);
  }
}

/** Print single object as JSON or key-value pairs */
export function detail(data: Record<string, unknown>, opts?: OutputOptions & { title?: string }) {
  if (isJson(opts)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (opts?.title) {
    console.log(`\n${opts.title}`);
    console.log('─'.repeat(50));
  }

  const maxKeyLen = Math.max(...Object.keys(data).map(k => k.length));
  for (const [key, value] of Object.entries(data)) {
    let display: string;
    if (value === null || value === undefined) {
      display = '(none)';
    } else if (Array.isArray(value)) {
      if (value.length === 0) display = '(none)';
      else if (typeof value[0] === 'object') display = JSON.stringify(value);
      else display = value.join(', ');
    } else if (typeof value === 'object') {
      display = JSON.stringify(value);
    } else {
      display = String(value);
    }
    const truncated = display.length > 120 ? display.slice(0, 117) + '...' : display;
    console.log(`  ${key.padEnd(maxKeyLen + 2)} ${truncated}`);
  }
}

/** Print JSON or simple success message */
export function success(message: string, data?: unknown, opts?: OutputOptions) {
  if (isJson(opts)) {
    console.log(JSON.stringify(data ?? { ok: true, message }, null, 2));
    return;
  }
  console.log(message);
}

/** Print error and exit */
export function fail(message: string, exitCode = 1): never {
  if (_globalJson) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

/** Extract array rows from API responses that wrap data under varying keys */
export function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) return val as Record<string, unknown>[];
    }
  }
  return [];
}

/** Print raw JSON or formatted list */
export function list(items: string[], opts?: OutputOptions & { title?: string }) {
  if (isJson(opts)) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (opts?.title) {
    console.log(`\n${opts.title}`);
    console.log('─'.repeat(40));
  }
  if (items.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const item of items) {
    console.log(`  ${item}`);
  }
}
