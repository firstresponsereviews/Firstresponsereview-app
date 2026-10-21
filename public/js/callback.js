// Invite and password-reset emails send people here with the session in the URL fragment.
// We hand it to the server (which stores it in secure cookies) and clear it from the address bar.
const msg = document.getElementById('callback-msg');
const hash = new URLSearchParams(location.hash.slice(1));
const query = new URLSearchParams(location.search);
history.replaceState(null, '', location.pathname);

const fail = (text) => {
  msg.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  const a = document.createElement('a');
  a.href = '/forgot-password';
  a.className = 'btn primary';
  a.textContent = 'Send me a new link';
  msg.append(p, a);
};

const error = hash.get('error_description') || query.get('error_description');
if (error) {
  fail('That link has expired or was already used.');
} else if (hash.get('access_token') && hash.get('refresh_token')) {
  fetch('/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      access_token: hash.get('access_token'),
      refresh_token: hash.get('refresh_token'),
      expires_in: hash.get('expires_in'),
      type: hash.get('type'),
    }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((d) => { location.replace(d.next || '/'); })
    .catch(() => fail('We couldn’t sign you in with that link.'));
} else {
  fail('This sign-in link is missing information.');
}
