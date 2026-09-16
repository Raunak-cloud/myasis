/**
 * Offline check: the select-style comboboxes real employer forms ship.
 *
 * Every case here is a widget whose accessible input cannot be clicked —
 * zero-width, covered by the box that draws it, or read-only — which is how
 * Ant Design (Dayforce), Workday and Salesforce all render a select. A click
 * on the input alone never becomes actionable, and four applications in one
 * night were spent re-answering a "Preferred contact method" dropdown that
 * never opened.
 *
 * No network, no model, no employer: a local page and the real fill path.
 *
 *   node scripts/test-combobox.mjs
 */
import { createServer } from 'node:http';
import { chromium } from 'patchright';
import { extractFields, fillField } from '../dist/dom.js';

/** An Ant Design select: the input is zero-width inside the styled box. */
const antSelect = (id, label, options) => `
  <label id="${id}-label">${label}</label>
  <div class="ant-select" data-for="${id}">
    <div class="ant-select-selector">
      <span class="ant-select-selection-search">
        <input readonly type="search" role="combobox" id="${id}" aria-labelledby="${id}-label"
               autocomplete="off" unselectable="on" style="width:0;opacity:0" required />
      </span>
      <span class="ant-select-selection-item" id="${id}-shown"></span>
    </div>
  </div>
  <script>
    (() => {
      const box = document.querySelector('[data-for="${id}"]');
      const open = () => {
        if (document.getElementById('${id}-list')) return;
        const list = document.createElement('div');
        list.id = '${id}-list';
        list.setAttribute('role', 'listbox');
        list.innerHTML = ${JSON.stringify(options)}
          .map((text) => '<div role="option">' + text + '</div>')
          .join('');
        box.appendChild(list);
        for (const option of list.children) {
          option.addEventListener('click', () => {
            document.getElementById('${id}-shown').textContent = option.textContent;
            list.remove();
          });
        }
      };
      box.querySelector('.ant-select-selector').addEventListener('mousedown', open);
      box.querySelector('.ant-select-selector').addEventListener('click', open);
    })();
  </script>`;

/** A Workday-style picker: a full-size input sitting under a transparent overlay. */
const coveredSelect = (id, label, options) => `
  <label id="${id}-label">${label}</label>
  <div class="dropdown-wrap" data-for="${id}" style="position:relative;width:240px">
    <input readonly type="text" role="combobox" id="${id}" aria-labelledby="${id}-label" style="width:100%" required />
    <div class="overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0)"></div>
    <span id="${id}-shown"></span>
  </div>
  <script>
    (() => {
      const box = document.querySelector('[data-for="${id}"]');
      box.querySelector('.overlay').addEventListener('click', () => {
        if (document.getElementById('${id}-list')) return;
        const list = document.createElement('div');
        list.id = '${id}-list';
        list.setAttribute('role', 'listbox');
        list.innerHTML = ${JSON.stringify(options)}
          .map((text) => '<div role="option">' + text + '</div>')
          .join('');
        document.body.appendChild(list);
        for (const option of list.children) {
          option.addEventListener('click', () => {
            document.getElementById('${id}-shown').textContent = option.textContent;
            document.getElementById('${id}').value = option.textContent;
            list.remove();
          });
        }
      });
    })();
  </script>`;

const page = `<!doctype html><meta charset="utf-8"><title>Employer form</title>
  <form>
    <h1>Application</h1>
    ${antSelect('pcm', 'Preferred contact method', ['Email', 'Phone', 'SMS'])}
    ${antSelect('state', 'State/Province', ['New South Wales', 'Victoria', 'Queensland'])}
    ${coveredSelect('heard', 'How did you hear about this job?', ['SEEK', 'Referral', 'Company website'])}
  </form>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (name, condition, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
const tab = await browser.newPage();
await tab.goto(url, { waitUntil: 'load' });

const fields = await extractFields(tab);
const find = (label) => fields.find((field) => field.label.replace(/\s+/g, ' ').trim() === label);

console.log('\ncomboboxes that will not take a click on their input');
for (const [label, value] of [
  ['Preferred contact method', 'Email'],
  ['State/Province', 'New South Wales'],
  ['How did you hear about this job?', 'SEEK'],
]) {
  const field = find(label);
  if (!field) {
    check(`${label}: found on the page`, false, `labels seen: ${fields.map((f) => f.label).join(' | ')}`);
    continue;
  }
  const started = Date.now();
  const error = await fillField(tab, field, value).then(() => null).catch((reason) => reason);
  check(`${label} → ${value}`, !error, `${error?.message ?? ''} after ${Date.now() - started}ms`);
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
