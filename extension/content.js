/**
 * Myasis Assist — content script.
 *
 * Runs inside the user's own SEEK session, on their own machine and IP. It
 * reads the application form, asks the local Myasis API for answers, fills
 * them in, and shows what it did.
 *
 * It never clicks Submit. That is the design, not an oversight: a human
 * reviewing each application is what keeps it accurate and genuinely theirs.
 */

const API = 'http://localhost:5180';

/** SEEK pads button and label text with invisible formatting characters. */
const clean = (s) => (s || '').replace(/[​-‍⁠﻿ ]/g, '').trim();

const jobIdFromUrl = () => (location.pathname.match(/\/job\/(\d+)/) || [])[1] || null;
const onApplyPage = () => /\/job\/\d+\/apply/.test(location.pathname);

// ---------------------------------------------------------------- panel

let panel;
function ui() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'myasis-panel';
  panel.innerHTML = `
    <div class="myasis-head">
      <span class="myasis-dot"></span>
      <strong>Myasis</strong>
      <button class="myasis-x" title="Hide">×</button>
    </div>
    <div class="myasis-body"></div>
    <div class="myasis-foot">You review and submit — Myasis never clicks Submit.</div>`;
  document.body.appendChild(panel);
  panel.querySelector('.myasis-x').onclick = () => panel.remove();
  return panel;
}

function say(html, tone = '') {
  const p = ui();
  p.querySelector('.myasis-body').innerHTML = html;
  p.dataset.tone = tone;
}

// ---------------------------------------------------------------- form IO

/**
 * Serialises the interactive fields on the current step.
 * Radio groups collapse to one logical field so the model picks an option
 * rather than reasoning about each input separately.
 */
function extractFields() {
  const fields = [];
  let n = 0;

  const labelFor = (el) => {
    const id = el.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l?.textContent?.trim()) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) return clean(wrap.textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const group = el.closest('fieldset, [role="group"], div');
    const legend = group?.querySelector('legend, h2, h3, strong');
    return clean(legend?.textContent) || el.getAttribute('name') || 'unlabelled field';
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  const radios = new Map();

  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'file') return;
    if (!visible(el) && el.type !== 'radio') return;

    if (el.type === 'radio') {
      const key = el.name || labelFor(el);
      if (!radios.has(key)) radios.set(key, []);
      radios.get(key).push(el);
      return;
    }

    const ref = `f${n++}`;
    el.dataset.myasisRef = ref;

    if (el.tagName === 'SELECT') {
      fields.push({
        ref, label: labelFor(el), kind: 'select',
        required: el.required || el.getAttribute('aria-required') === 'true',
        options: [...el.options].map((o) => clean(o.textContent)).filter(Boolean),
        currentValue: el.value,
      });
      return;
    }
    fields.push({
      ref, label: labelFor(el),
      kind: el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'checkbox' ? 'checkbox' : 'text',
      required: el.required || el.getAttribute('aria-required') === 'true',
      currentValue: el.type === 'checkbox' ? String(el.checked) : el.value,
    });
  });

  radios.forEach((inputs, key) => {
    const ref = `f${n++}`;
    inputs.forEach((i, idx) => (i.dataset.myasisRef = `${ref}:${idx}`));
    const legend = inputs[0].closest('fieldset')?.querySelector('legend');
    fields.push({
      ref,
      label: clean(legend?.textContent) || key,
      kind: 'radio',
      required: inputs.some((i) => i.required),
      options: inputs.map(labelFor),
    });
  });

  return fields;
}

/** React tracks its own value, so a plain assignment is ignored — use the native setter. */
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const flash = (el) => {
  el.classList.add('myasis-filled');
  setTimeout(() => el.classList.remove('myasis-filled'), 2600);
};

function fillField(field, value) {
  if (field.kind === 'radio') {
    const idx = (field.options || []).findIndex((o) => o.toLowerCase() === value.toLowerCase());
    const pick = idx >= 0 ? idx : (field.options || []).findIndex((o) =>
      o.toLowerCase().includes(value.toLowerCase()));
    if (pick < 0) return false;
    const input = document.querySelector(`[data-myasis-ref="${field.ref}:${pick}"]`);
    if (!input) return false;
    // SEEK's radios are custom components whose real input is hidden and never
    // reports `checked` — clicking the label is what actually selects them.
    const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    (label || input).click();
    if (label) flash(label);
    return true;
  }

  const el = document.querySelector(`[data-myasis-ref="${field.ref}"]`);
  if (!el) return false;

  if (field.kind === 'select') {
    const opt = [...el.options].find((o) => clean(o.textContent).toLowerCase() === value.toLowerCase());
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (field.kind === 'checkbox') {
    const want = value.toLowerCase() === 'true';
    if (el.checked !== want) el.click();
  } else {
    setNativeValue(el, value);
  }
  flash(el);
  return true;
}

// ---------------------------------------------------------------- main

async function assist() {
  const jobId = jobIdFromUrl();
  say('Reading the form…');

  // The cover-letter box only exists once its radio is chosen.
  const writeOpt = [...document.querySelectorAll('input[type=radio]')].find((r) =>
    /write a cover letter/i.test(clean(r.closest('label')?.textContent || '')));
  if (writeOpt && !writeOpt.checked) {
    (writeOpt.closest('label') || writeOpt).click();
    await new Promise((r) => setTimeout(r, 700));
  }

  const fields = extractFields();
  if (!fields.length) {
    say('No form fields found on this step.', 'warn');
    return;
  }

  say(`Drafting answers for ${fields.length} field${fields.length > 1 ? 's' : ''}…`);

  /**
   * Routed through the service worker on purpose. A `fetch` from here would be
   * evaluated against SEEK's Content Security Policy, which blocks localhost —
   * and it hangs forever rather than throwing, so the UI would just sit on
   * "Drafting…" with no error.
   */
  const reply = await chrome.runtime.sendMessage({
    type: 'api',
    path: '/api/assist/answer',
    body: {
      jobId,
      title: clean(document.querySelector('h1')?.textContent || ''),
      company: clean(document.querySelector('[data-automation="advertiser-name"]')?.textContent || ''),
      description: clean(document.body.innerText).slice(0, 4000),
      fields,
    },
  }).catch((e) => ({ ok: false, error: e?.message || 'extension messaging failed' }));

  if (!reply?.ok) {
    say(
      `Cannot reach Myasis at <code>${API}</code>.<br><small>${reply?.error ?? 'Is the dashboard running?'}</small>`,
      'bad',
    );
    return;
  }
  const data = reply.data;
  if (!data.ok) {
    say(`Myasis error: ${data.error}`, 'bad');
    return;
  }

  let filled = 0;
  const needsYou = [];

  /**
   * The queue's letter wins.
   *
   * It is the one the user actually read and possibly edited, so it must
   * override both the generic answer and — critically — whatever SEEK left
   * pre-filled. SEEK caches your previous cover letter into the next
   * application, which means an untouched box can be addressed to a completely
   * different employer.
   */
  const letterField = fields.find((f) => f.kind === 'textarea' && /cover letter/i.test(f.label));
  if (data.coverLetter && letterField) {
    if (fillField(letterField, data.coverLetter)) filled++;
    // Do not let the generic pass overwrite it.
    data.answers = (data.answers || []).filter((a) => a.ref !== letterField.ref);
  }

  for (const a of data.answers || []) {
    const field = fields.find((f) => f.ref === a.ref);
    if (!field) continue;
    // Ungrounded answers are left blank on purpose — better an empty box the
    // user notices than a confident guess sent to an employer.
    if (!a.grounded) {
      needsYou.push({ label: field.label, why: a.rationale });
      continue;
    }
    if (fillField(field, a.value)) filled++;
  }

  const parts = [`<strong>Filled ${filled} field${filled === 1 ? '' : 's'}.</strong>`];
  if (data.injectionSuspected)
    parts.push('<div class="myasis-warn">⚠ This listing contains text trying to manipulate the AI. It was ignored.</div>');
  if (needsYou.length) {
    parts.push(`<div class="myasis-warn">${needsYou.length} left for you:<ul>` +
      needsYou.map((n) => `<li>${n.label}${n.why ? ` <small>— ${n.why}</small>` : ''}</li>`).join('') +
      '</ul></div>');
  }
  parts.push('<div class="myasis-ok">Review everything, then click SEEK\'s Submit button yourself.</div>');
  say(parts.join(''), needsYou.length ? 'warn' : 'ok');

  chrome.runtime.sendMessage({ type: 'filled', jobId, filled, needsYou: needsYou.length }).catch(() => {});
}

// ---------------------------------------------------------------- boot

/**
 * Closes the loop.
 *
 * In this design the human submits, so nothing server-side would ever learn the
 * application happened — and the job would resurface in tomorrow's queue.
 * SEEK lands on /apply/success, which is an unambiguous confirmation.
 */
async function reportSuccess() {
  const jobId = jobIdFromUrl();
  if (!jobId) return;
  const key = `myasis-reported-${jobId}`;
  if (sessionStorage.getItem(key)) return; // don't double-report on re-render
  sessionStorage.setItem(key, '1');

  const reply = await chrome.runtime
    .sendMessage({
      type: 'api',
      path: '/api/queue',
      method: 'PATCH',
      body: { jobId, patch: { status: 'applied' } },
    })
    .catch(() => null);

  say(
    reply?.ok
      ? '<div class="myasis-ok"><strong>Application sent.</strong><br>Marked as applied — it won\'t appear in your queue again.</div>'
      : '<div class="myasis-warn">Application sent, but Myasis could not record it.<br><small>Mark it applied in the dashboard so it is not re-queued.</small></div>',
    reply?.ok ? 'ok' : 'warn',
  );
}

function boot() {
  if (/\/apply\/success/.test(location.pathname)) {
    void reportSuccess();
    return;
  }
  if (!onApplyPage()) return;
  const p = ui();
  p.querySelector('.myasis-body').innerHTML =
    '<button class="myasis-go">Fill this form</button>' +
    '<div class="myasis-hint">Uses your Myasis profile and documents.</div>';
  p.querySelector('.myasis-go').onclick = assist;
}

boot();

// SEEK's apply flow is a SPA — re-arm the panel when the step changes.
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  panel?.remove();
  panel = null;
  boot();
}, 1000);

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.type === 'fill-now') {
    assist().then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === 'status') {
    reply({ onApplyPage: onApplyPage(), jobId: jobIdFromUrl() });
  }
});
