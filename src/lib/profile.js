// The user's preferences profile: a small markdown file the agent reads on
// every run so patches match how this person likes pages to be.
//
//   # My preferences
//   - [x] Larger text
//   - [ ] High contrast
//   ...
//   ## Notes
//   free text

export const PRESETS = [
  { id: 'larger-text', label: 'Larger text', hint: 'Base font size at least 18px; nothing smaller than 14px.' },
  { id: 'high-contrast', label: 'High contrast', hint: 'Dark text on light backgrounds (or the reverse), no light-grey-on-white.' },
  { id: 'readable-font', label: 'Readable font', hint: 'A plain sans-serif with generous letter spacing; no thin weights.' },
  { id: 'reduce-motion', label: 'Reduce motion', hint: 'No animations, transitions, autoplay or parallax.' },
  { id: 'hide-promos', label: 'Hide promotions', hint: 'Banners, upsells, newsletter prompts and cookie nags go away.' },
  { id: 'compact', label: 'Compact layout', hint: 'Less padding and whitespace; more content per screen.' },
  { id: 'dark', label: 'Prefer dark', hint: 'Dark backgrounds where the site offers none.' },
  { id: 'keyboard', label: 'Keyboard first', hint: 'Visible focus rings, sensible tab order, no keyboard traps.' },
  { id: 'big-targets', label: 'Bigger click targets', hint: 'Buttons, links and form fields at least 40px tall.' },
  { id: 'focus', label: 'Focus mode', hint: 'Hide sidebars, related content and chatter; keep the main task.' },
];

export const DEFAULT_PROFILE = { presets: [], notes: '' };

const HEADER = '# My preferences';
const NOTES = '## Notes';

/** Parse the markdown profile. Unknown checkbox lines are kept as notes. */
export function parseProfile(md) {
  const out = { presets: [], notes: '' };
  if (typeof md !== 'string' || !md.trim()) return out;
  const lines = md.split(/\r?\n/);
  const notes = [];
  let inNotes = false;
  for (const line of lines) {
    if (line.trim() === NOTES) {
      inNotes = true;
      continue;
    }
    if (inNotes) {
      notes.push(line);
      continue;
    }
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.+?)\s*$/);
    if (m) {
      const preset = PRESETS.find((p) => p.label.toLowerCase() === m[2].toLowerCase() || p.id === m[2].toLowerCase());
      if (preset) {
        if (m[1].toLowerCase() === 'x' && !out.presets.includes(preset.id)) out.presets.push(preset.id);
      } else if (m[1].toLowerCase() === 'x') notes.push(m[2]);
      continue;
    }
    if (line.trim() && line.trim() !== HEADER && !line.startsWith('#')) notes.push(line);
  }
  out.notes = notes.join('\n').trim();
  return out;
}

export function formatProfile(profile = DEFAULT_PROFILE) {
  const presets = new Set(profile.presets || []);
  const lines = [HEADER, ''];
  for (const p of PRESETS) lines.push(`- [${presets.has(p.id) ? 'x' : ' '}] ${p.label}`);
  lines.push('', NOTES, '', (profile.notes || '').trim(), '');
  return lines.join('\n');
}

/** What the agent sees. Empty string when nothing is set. */
export function profileForPrompt(profile) {
  const chosen = PRESETS.filter((p) => profile?.presets?.includes(p.id));
  const notes = (profile?.notes || '').trim();
  if (!chosen.length && !notes) return '';
  const parts = ['The user\'s standing preferences (apply them whenever they are relevant to the request, and always when asked to tailor a page):'];
  for (const p of chosen) parts.push(`- ${p.label}: ${p.hint}`);
  if (notes) parts.push(`- In their own words: ${notes}`);
  return parts.join('\n');
}

export function isEmptyProfile(profile) {
  return !profile?.presets?.length && !(profile?.notes || '').trim();
}
