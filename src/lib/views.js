// Views: named sets of patches per site. One view is active per site;
// `null` means "Original" (no patches).

export const ORIGINAL = null;

export function newViewId() {
  const rnd = globalThis.crypto?.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `v_${Date.now().toString(36)}_${rnd}`;
}

export function makeView(origin, name) {
  return { id: newViewId(), origin, name: String(name || 'View').trim().slice(0, 60) || 'View', createdAt: Date.now() };
}

/** Views for one origin, oldest first. */
export function viewsForOrigin(views, origin) {
  return Object.values(views || {})
    .filter((v) => v && v.origin === origin)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Next view id when cycling: Original -> first -> second -> ... -> Original.
 * Returns ORIGINAL when the site has no views.
 */
export function nextView(views, origin, current) {
  const list = viewsForOrigin(views, origin);
  if (!list.length) return ORIGINAL;
  if (current == null) return list[0].id;
  const idx = list.findIndex((v) => v.id === current);
  if (idx === -1 || idx === list.length - 1) return ORIGINAL;
  return list[idx + 1].id;
}

export function viewName(views, id) {
  if (id == null) return 'Original';
  return views?.[id]?.name || 'Unknown view';
}

/** Patches that belong to the active view for this origin. */
export function patchesInView(patches, viewId) {
  if (viewId == null) return [];
  return Object.values(patches || {}).filter((p) => p && p.viewId === viewId);
}
