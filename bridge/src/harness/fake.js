// A deterministic in-process "agent" used by the tests, the end-to-end
// suite and demos. It drives the same tools a real harness would, so the
// whole path (bridge -> extension -> page -> verification) is exercised
// without any model.
//
// It understands a tiny command language in the request, one per line:
//   hide <selector>            hide an element (listed as intentional)
//   css <css>                  inject CSS
//   text <selector> => <text>  replace text
//   value <selector> => <v>    prefill a field
//   style <selector> => <css>  inline style
//   attr <selector> <name>=<v> set an attribute (protected ones are refused)
//   break                      hide every button without listing it (fails verify)
//   refuse <text>              decline this part with an alternative
//   nopatch                    finish without a patch
//   risky                      report risk = high
//   js <code>                  add JavaScript (refused by the bridge unless allowed)
//   tailor                     apply the profile presets found in the prompt as CSS
//   fail                       throw, to exercise error handling

export function createFakeHarness() {
  return {
    name: 'fake',
    label: 'Fake (tests)',
    command: null,
    async run({ prompt, callTool, onEvent, signal }) {
      const marker = prompt.lastIndexOf('Request: ');
      const request = marker === -1 ? prompt : prompt.slice(marker + 'Request: '.length);
      const lines = request
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.includes('fail')) throw new Error('fake harness failure');
      onEvent({ kind: 'assistant', text: 'Let me look at the page first.' });
      const outline = await callTool('page_outline', {});
      if (signal?.aborted) throw new Error('aborted');

      const patch = { name: 'Fake patch', summary: '', css: '', js: '', rules: [], intentionallyHidden: [], notes: '' };
      const declined = [];
      const warnings = [];
      let risk = 'low';
      let nopatch = false;
      for (const line of lines) {
        const [rawCmd, ...rest] = line.split(' ');
        const cmd = rawCmd.toLowerCase();
        const arg = rest.join(' ');
        const [sel, val] = arg.split(' => ');
        switch (cmd) {
          case 'hide':
            patch.rules.push({ action: 'hide', selector: arg });
            patch.intentionallyHidden.push(arg);
            break;
          case 'css':
            patch.css += arg + '\n';
            break;
          case 'js':
            patch.js += arg + '\n';
            break;
          case 'tailor':
            if (/- Larger text:/.test(prompt)) patch.css += 'html{font-size:20px !important}\n';
            if (/- Hide promotions:/.test(prompt)) {
              patch.rules.push({ action: 'hide', selector: '.promo' });
              patch.intentionallyHidden.push('.promo');
            }
            if (/- Prefer dark:/.test(prompt)) patch.css += 'body{background:#111 !important;color:#eee !important}\n';
            if (/In their own words: (.+)/.test(prompt)) patch.notes = 'Applied your note: ' + prompt.match(/In their own words: (.+)/)[1];
            patch.name = 'Tailored to my profile';
            break;
          case 'text':
            patch.rules.push({ action: 'setText', selector: sel, text: val ?? '' });
            break;
          case 'value':
            patch.rules.push({ action: 'setValue', selector: sel, value: val ?? '' });
            break;
          case 'style':
            patch.rules.push({ action: 'style', selector: sel, value: val ?? '' });
            break;
          case 'attr': {
            const [selector, ...kv] = arg.split(' ');
            const [name, value = ''] = kv.join(' ').split('=');
            patch.rules.push({ action: 'setAttribute', selector, name, value });
            break;
          }
          case 'break':
            patch.rules.push({ action: 'style', selector: 'button', value: 'display: none' });
            break;
          case 'refuse':
            declined.push({ request: arg, reason: 'That would change what the form sends to the server.', alternative: 'Hide or restyle the field instead.' });
            break;
          case 'nopatch':
            nopatch = true;
            break;
          case 'risky':
            risk = 'high';
            warnings.push('This patch changes how you interact with the form.');
            break;
          default:
            break;
        }
      }
      if (outline.volatility?.volatile) {
        warnings.push('This page re-renders itself; the patch may not hold.');
        if (risk === 'low') risk = 'medium';
      }

      const empty = !patch.css.trim() && !patch.js.trim() && patch.rules.length === 0;
      if (nopatch || empty) {
        await callTool('finish', {
          message: declined.length ? 'I did not make changes: ' + declined.map((d) => d.reason).join(' ') : 'Nothing to change.',
          patch: null,
          risk: 'low',
          warnings,
          declined,
        });
        return { lastText: 'finished without a patch' };
      }

      patch.summary = `${patch.rules.length} rule(s)${patch.css ? ' and custom CSS' : ''}${patch.js ? ' and JavaScript' : ''}`;
      onEvent({ kind: 'assistant', text: 'Previewing the change.' });
      const preview = await callTool('preview_patch', { patch });
      if (!preview.ok) {
        await callTool('finish', {
          message: 'The patch was rejected: ' + preview.errors.join('; '),
          patch: null,
          risk: 'high',
          warnings: preview.errors,
          declined: declined.concat(preview.errors.map((e) => ({ request: request, reason: e, alternative: 'Ask for a presentation-only change.' }))),
        });
        return { lastText: 'rejected' };
      }
      const report = await callTool('verify', {});
      if (!report.ok) {
        await callTool('clear_preview', {});
        await callTool('finish', {
          message: `I tried, but verification failed: ${report.summary}. I have not applied anything.`,
          patch: null,
          risk: 'high',
          warnings: report.checks.filter((c) => !c.ok).flatMap((c) => c.details),
          declined: declined.concat([{ request, reason: report.summary, alternative: 'Ask for a smaller change that keeps every control visible.' }]),
        });
        return { lastText: 'verification failed' };
      }
      await callTool('finish', {
        message: `Done. ${patch.summary}. Verification passed.`,
        patch,
        risk,
        warnings,
        declined,
      });
      return { lastText: 'finished', cost: 0, turns: 1 };
    },
  };
}
