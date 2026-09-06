/**
 * Service worker.
 *
 * It exists mainly to own the network call. A content script's `fetch` runs
 * against the page's Content Security Policy — SEEK's blocks localhost, and the
 * request hangs forever rather than failing. The service worker is not bound by
 * page CSP, so all API traffic is proxied through here.
 *
 * It holds no credentials and stores nothing about the user.
 */

const API = 'http://localhost:5180';

async function callApi(path, body, method) {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Myasis API ${res.status}`);
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'api') {
    callApi(msg.path, msg.body, msg.method)
      .then((data) => reply({ ok: true, data }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true; // keep the channel open for the async reply
  }

  if (msg?.type === 'filled') {
    chrome.action.setBadgeText({ text: String(msg.filled) });
    chrome.action.setBadgeBackgroundColor({ color: msg.needsYou ? '#fbbf24' : '#34d399' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 12000);
  }
});
