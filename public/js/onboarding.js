// Step-by-step questionnaire with a live preview of how replies will sound.
// Without JavaScript all five steps show on one page and the form still works.
import { replyText } from '/static/shared/replies.js';

const form = document.getElementById('quiz');
if (form) {
  const steps = [...form.querySelectorAll('.qstep')];
  const bars = [...form.querySelectorAll('.progress span')];
  const back = form.querySelector('[data-back]');
  const next = form.querySelector('[data-next]');
  let i = 0;

  const values = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((el) => el.value);
  const val = (name) => (form.elements[name] ? form.elements[name].value : '');

  function answers() {
    return {
      business: { name: val('business_name'), industry: val('industry'), city: val('city') },
      contact: { manager: val('manager'), role: val('role'), phone: val('phone'), email: val('contact_email'), callback: val('callback'), method: (values('method')[0] || 'call') },
      voice: { formality: Number(val('formality')), length: Number(val('length')), words: values('words'), sign: val('sign'), emoji: val('emoji'), love: val('love'), never: val('never') },
      rules: { thankStaff: form.elements.thankStaff && form.elements.thankStaff.checked, healthPrivacy: form.elements.healthPrivacy && form.elements.healthPrivacy.checked },
    };
  }

  function preview() {
    const g = answers();
    document.getElementById('pvLow').textContent = replyText(g, { name: 'Dana', rating: 1, issue: g.rules.healthPrivacy ? 'your experience' : 'the long wait' });
    document.getElementById('pvHigh').textContent = replyText(g, { name: 'Jordan', rating: 5, extra: g.rules.thankStaff ? ' We’ll make sure Ana hears this.' : '' });
  }

  function show(n) {
    i = Math.max(0, Math.min(steps.length - 1, n));
    steps.forEach((s, k) => { s.hidden = k !== i; });
    bars.forEach((b, k) => b.classList.toggle('on', k <= i));
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Build my guidelines' : 'Next';
    const first = steps[i].querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (first && document.activeElement !== document.body) first.focus({ preventScroll: true });
  }

  // Keep the personality picks to three.
  form.addEventListener('change', (e) => {
    if (e.target.name === 'words' && values('words').length > 3) e.target.checked = false;
  });
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  back.addEventListener('click', () => { show(i - 1); window.scrollTo({ top: 0 }); });
  form.addEventListener('submit', (e) => {
    if (i < steps.length - 1) {
      e.preventDefault();
      show(i + 1);
      window.scrollTo({ top: 0 });
    }
  });

  // If the server sent back errors, open the step with the first problem field.
  const errorStep = steps.findIndex((s) => s.querySelector(':invalid'));
  show(document.querySelector('.notice.error') && errorStep >= 0 ? errorStep : 0);
  preview();
}
