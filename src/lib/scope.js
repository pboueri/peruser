// URL scope matching for patches.
//
// A scope is { type: 'origin' | 'prefix' | 'exact', origin, path }.
//   origin  – every page on the site (scheme + host + port)
//   prefix  – pages whose path starts with `path`
//   exact   – one page (path + query, hash ignored)

export const SCOPE_TYPES = ['origin', 'prefix', 'exact'];

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizePath(path) {
  if (!path) return '/';
  let p = path.startsWith('/') ? path : '/' + path;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Build a scope of the given type for a URL. */
export function makeScope(type, url) {
  const u = parse(url);
  if (!u) throw new Error(`Invalid URL: ${url}`);
  if (!SCOPE_TYPES.includes(type)) throw new Error(`Unknown scope type: ${type}`);
  const scope = { type, origin: u.origin };
  if (type === 'prefix') scope.path = normalizePath(u.pathname);
  if (type === 'exact') scope.path = normalizePath(u.pathname) + u.search;
  return scope;
}

/** Does `url` fall inside `scope`? */
export function scopeMatches(scope, url) {
  const u = parse(url);
  if (!u || !scope || u.origin !== scope.origin) return false;
  switch (scope.type) {
    case 'origin':
      return true;
    case 'prefix': {
      const want = normalizePath(scope.path);
      const have = normalizePath(u.pathname);
      return want === '/' || have === want || have.startsWith(want + '/');
    }
    case 'exact': {
      const have = normalizePath(u.pathname) + u.search;
      return have === scope.path;
    }
    default:
      return false;
  }
}

/** Human-readable description for the UI. */
export function describeScope(scope) {
  if (!scope) return '';
  const host = scope.origin.replace(/^https?:\/\//, '');
  switch (scope.type) {
    case 'origin':
      return `all of ${host}`;
    case 'prefix':
      return `${host}${scope.path}${scope.path === '/' ? '' : '/…'}`;
    case 'exact':
      return `${host}${scope.path}`;
    default:
      return host;
  }
}

/** Specificity order so more specific scopes apply after broader ones. */
export function scopeRank(scope) {
  return SCOPE_TYPES.indexOf(scope?.type ?? 'origin');
}
