// Stable, filesystem-safe names for sites, views and patches.

export function slugify(input, { max = 48, fallback = 'item' } = {}) {
  const s = String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || fallback;
}

/** "https://mail.google.com:8443" -> "mail.google.com_8443" */
export function siteSlug(origin) {
  try {
    const u = new URL(origin);
    const host = (u.hostname || 'file').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
    return (host + (u.port ? `_${u.port}` : '')).slice(0, 80);
  } catch {
    return slugify(origin, { max: 80, fallback: 'site' });
  }
}

/** Make `base` unique among `taken` by appending -2, -3, ... */
export function uniqueSlug(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let i = 2;
  while (set.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
