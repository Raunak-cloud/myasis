import { useId, useState } from 'react';
import { employerTargets, type EMPLOYER_SOURCES } from '../../../seek-bot/src/employer-source-config';
import './EmployerSourceEditor.css';

type Source = typeof EMPLOYER_SOURCES[number];
const names: Record<string, string> = {
  luxuryescapes: 'Luxury Escapes', ncsaustralia: 'NCS Australia', apmgroup: 'APM Group',
  aristanetworks: 'Arista Networks', cuscal1: 'Cuscal', servicenow: 'ServiceNow',
  carsales: 'carsales', kpmgaustralia1: 'KPMG Australia', aldi1: 'ALDI', aldistores: 'ALDI',
  theiconic: 'THE ICONIC', futuresecureai: 'Future Secure AI', imc: 'IMC',
};

function companyName(entry: string): string {
  if (entry.includes('|')) return entry.split('|')[0].trim();
  let name = entry;
  try { name = new URL(entry).hostname.split('.')[0]; } catch { /* A saved company name. */ }
  return names[name.toLowerCase()] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, letter => letter.toUpperCase());
}
const targetKey = (entry: string) => entry.split('|').at(-1)!.replace(/\/$/, '').toLowerCase();

/** Keep the existing saved format behind a company list and a careers-link form. */
export function EmployerSourceEditor({ source, value, onChange }: { source: Source; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const visible = expanded ? entries : entries.slice(0, 6);
  const example = source.id === 'smartrecruiters' ? 'https://jobs.smartrecruiters.com/Canva'
    : source.id === 'greenhouse' ? 'https://job-boards.greenhouse.io/theiconic'
    : source.defaults.split(',')[0].split('|').at(-1)!;

  function add() {
    setError('');
    try {
      let target = link.trim();
      if (!target) throw Error('Enter the company’s careers page.');
      if (source.kind === 'identifiers' && /^https?:\/\//i.test(target)) {
        const url = new URL(target);
        const hosts = source.id === 'greenhouse' ? ['job-boards.greenhouse.io', 'boards.greenhouse.io']
          : ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'];
        if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) throw Error(`Use the company’s ${source.label} careers page.`);
        target = url.pathname.split('/').filter(Boolean)[0] ?? '';
      }
      if (source.kind === 'urls') {
        if (!name.trim()) throw Error('Enter the company name.');
        if (/[,|]/.test(name)) throw Error('Use a company name without commas or vertical bars.');
        target = `${name.trim()}|${target}`;
      }
      const entry = employerTargets(source.id, target)[0];
      if (!entry) throw Error('That careers page is no longer available.');
      if (entries.some(existing => targetKey(existing) === targetKey(entry))) throw Error('This company is already on the list.');
      if (entries.length >= 20) throw Error('You can add up to 20 companies for this source.');
      onChange([...entries, entry].join(','));
      setAnnouncement(`Added ${companyName(entry)}.`);
      setName(''); setLink(''); setAdding(false);
    } catch (issue) {
      const message = (issue as Error).message;
      setError(/identifiers|career-site root|Employer name\||Invalid URL/.test(message)
        ? `Enter a valid company careers page for ${source.label}.` : message);
    }
  }

  return <section className="employer-source-editor" aria-labelledby={`${id}-title`}>
    <div className="employer-source-head">
      <div><h4 id={`${id}-title`}>{source.label}</h4><p>{entries.length} {entries.length === 1 ? 'company' : 'companies'}{source.id !== 'greenhouse' ? ' added' : ' included'}</p></div>
      <button className="btn" type="button" aria-expanded={adding} aria-controls={`${id}-add`} onClick={() => { setAdding(!adding); setError(''); }}> {adding ? 'Cancel' : '+ Add company'}</button>
    </div>
    {source.id !== 'greenhouse' && <p className="employer-source-note">Owtomate also searches its growing {source.label} directory automatically. Add extra companies here.</p>}
    <ul className="employer-company-list" aria-label={`${source.label} companies`}>
      {visible.map((entry, index) => <li key={`${entry}-${index}`}><span>{companyName(entry)}</span><button type="button" aria-label={`Remove ${companyName(entry)} from ${source.label}`} onClick={() => {
        onChange(entries.filter((_, position) => position !== index).join(','));
        setAnnouncement(`Removed ${companyName(entry)}.`); setError('');
      }}>×</button></li>)}
    </ul>
    {!entries.length && <p className="employer-source-note">No companies added.</p>}
    {entries.length > 6 && <button className="employer-list-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer' : `Show all ${entries.length} companies`}</button>}
    {adding && <div id={`${id}-add`} className="employer-company-add" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}>
      {source.kind === 'urls' && <label htmlFor={`${id}-name`}>Company name<input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Nine" /></label>}
      <label htmlFor={`${id}-link`}>Company careers page<input id={`${id}-link`} autoFocus value={link} onChange={event => setLink(event.target.value)} placeholder={example} aria-describedby={`${id}-help`} aria-invalid={Boolean(error)} /></label>
      <p id={`${id}-help`} className="employer-source-note">Paste the link to the company’s careers page on {source.label}.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="btn primary" type="button" onClick={add}>Add company</button>
    </div>}
    <span className="sr-only" aria-live="polite">{announcement}</span>
  </section>;
}
