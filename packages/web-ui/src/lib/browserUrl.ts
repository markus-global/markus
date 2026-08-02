/**
 * Normalize address-bar / navigate input for the embedded browser.
 * Supports http(s), file://, about:blank, and bare filesystem paths.
 */
export function normalizeBrowserUrl(raw: string): string {
  const next = raw.trim();
  if (!next) return next;
  if (next === 'about:blank') return next;

  // Already has a URI scheme (http, https, file, data, …).
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) {
    if (/^file:/i.test(next)) return normalizeFileUrl(next);
    return next;
  }

  // Absolute local paths → file://
  if (isAbsoluteFilesystemPath(next)) {
    return pathToFileUrl(next);
  }

  // Bare host / search-like input → https
  return `https://${next}`;
}

function isAbsoluteFilesystemPath(input: string): boolean {
  if (input.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (input.startsWith('\\\\')) return true;
  return false;
}

function pathToFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/');
  // UNC \\server\share → file://server/share
  if (p.startsWith('//')) {
    return `file:${encodePathKeepSlashes(p)}`;
  }
  // Windows drive letter
  if (/^[a-zA-Z]:\//.test(p)) {
    return `file:///${encodePathKeepSlashes(p)}`;
  }
  // POSIX absolute
  return `file://${encodePathKeepSlashes(p)}`;
}

function normalizeFileUrl(input: string): string {
  try {
    return new URL(input).href;
  } catch {
    // Repair file:/Users/... or file:C:/... (missing slashes)
    let rest = input.replace(/^file:/i, '').replace(/\\/g, '/');
    if (rest.startsWith('//')) {
      // file://host/path or file:///path — drop authority slash pair
      rest = rest.replace(/^\/\/(localhost)?/i, '');
      if (!rest.startsWith('/') && !/^[a-zA-Z]:\//.test(rest)) rest = `/${rest}`;
    }
    if (/^\/[a-zA-Z]:\//.test(rest)) rest = rest.slice(1);
    if (!rest.startsWith('/') && !/^[a-zA-Z]:\//.test(rest)) rest = `/${rest}`;
    return pathToFileUrl(rest);
  }
}

/** encodeURI keeps `/`; still escape `#` which would truncate the path. */
function encodePathKeepSlashes(p: string): string {
  return encodeURI(p).replace(/#/g, '%23');
}
