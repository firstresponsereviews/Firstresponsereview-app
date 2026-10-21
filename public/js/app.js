import { bannedPhrases, wordCount } from '/static/shared/replies.js';

// Selects that submit their form when changed (filters, business switcher).
document.querySelectorAll('select[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

// Copy-to-clipboard buttons (Yelp and G2 replies are pasted by the client).
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const el = document.querySelector(btn.dataset.copy);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value);
      btn.textContent = 'Copied ✓';
    } catch {
      el.select();
      btn.textContent = 'Press Ctrl/Cmd + C';
    }
    setTimeout(() => { btn.textContent = 'Copy reply'; }, 2500);
  });
});

// Live word count and never-say check on the reply box.
const reply = document.getElementById('reply');
if (reply) {
  const wc = document.getElementById('wc');
  const msg = document.getElementById('bannedMsg');
  const submits = reply.form.querySelectorAll('button[type=submit]');
  const check = () => {
    const words = wordCount(reply.value);
    wc.textContent = `${words} words${words > 80 ? ' · aim for under 80' : ''}`;
    const hits = bannedPhrases(reply.value, reply.dataset.never);
    msg.innerHTML = '';
    if (hits.length) {
      const p = document.createElement('p');
      p.className = 'flag';
      p.textContent = `Remove “${hits.join('”, “')}” — it’s on your never-say list.`;
      msg.append(p);
    }
    submits.forEach((b) => { b.disabled = hits.length > 0 || words === 0; });
  };
  reply.addEventListener('input', check);
  check();
}
