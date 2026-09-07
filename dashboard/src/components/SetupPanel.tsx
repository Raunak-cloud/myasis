import { useEffect, useState } from 'react';
import { FilesPanel } from './FilesPanel';
import { useSetupStatus } from './SetupChecklist';
import { ProfileForm } from './ProfileForm';
import { FieldLabel } from './FieldLabel';
import { AUSTRALIAN_CITIES } from '../runSettings';
import { SearchTermsGenerator } from './SearchTermsGenerator';

const ARRANGEMENTS = [
  { id: 'remote', label: 'Remote', hint: 'anywhere in Australia' },
  { id: 'hybrid', label: 'Hybrid', hint: 'anywhere in Australia' },
  { id: 'onsite', label: 'On-site', hint: 'your city only' },
];

/** A numbered step that shows its own completion state. */
function Step({
  n,
  title,
  blurb,
  done,
  children,
}: {
  n: number;
  title: string;
  blurb: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="card step">
      <summary className="step-head">
        <span className={`step-n ${done ? 'done' : ''}`}>{done ? '✓' : n}</span>
        <div>
          <h3 className="step-title">{title}</h3>
          <p className="job-meta step-blurb">{blurb}</p>
        </div>
        <span className="step-chevron" aria-hidden="true">+</span>
      </summary>
      <div className="step-body">{children}</div>
    </details>
  );
}

export function SetupPanel() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resumeLibraryVersion, setResumeLibraryVersion] = useState(0);
  const status = useSetupStatus();

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => {});
  }, []);

  const val = (k: string, d = '') => edits[k] ?? settings[k] ?? d;
  const set = (k: string, v: string) => {
    setEdits({ ...edits, [k]: v });
    setSaved(false);
  };
  const csv = (k: string, d = '') =>
    val(k, d).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const toggle = (k: string, item: string, d: string) => {
    const cur = new Set(csv(k, d));
    if (cur.has(item)) cur.delete(item);
    else cur.add(item);
    set(k, [...cur].join(','));
  };

  async function save() {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: edits }),
    });
    const j = await res.json();
    if (j.settings) setSettings(j.settings);
    setEdits({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const done = (id: string) => status?.checks.find((c) => c.id === id)?.done ?? false;
  const arrangements = csv('WORK_ARRANGEMENTS', 'remote,hybrid,onsite');
  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="setup-steps">
      <Step
        n={1}
        title="Your details"
        blurb="Used to answer common application questions accurately."
        done={done('profile')}
      >
        <ProfileForm />
      </Step>

      <Step
        n={2}
        title="Your documents"
        blurb="Your résumé and any supporting information the automation can use."
        done={done('resume')}
      >
        <FilesPanel onChanged={() => setResumeLibraryVersion((value) => value + 1)} />
      </Step>

      <Step
        n={3}
        title="What you're looking for"
        blurb="Choose the roles you want the automation to find."
        done={done('keywords')}
      >
        <div className="field">
          <FieldLabel label="Job titles to search" help="The roles and keywords used to search for job listings. Separate multiple terms with commas." />
          <textarea
            className="input mono-input"
            rows={4}
            placeholder="react developer, full stack engineer, node.js developer"
            value={val('KEYWORDS')}
            onChange={(e) => set('KEYWORDS', e.target.value)}
          />
          <SearchTermsGenerator
            currentTerms={val('KEYWORDS')}
            targetRole={val('TARGET_ROLE')}
            refreshKey={resumeLibraryVersion}
            onGenerated={(terms) => set('KEYWORDS', terms)}
          />
          <span className="job-meta">Comma separated. More terms cast a wider net.</span>
        </div>

        <label className="field">
          <FieldLabel label="Targeting a different field?" optional help="Use this when moving into a different type of work. Leave it blank to match your current experience." />
          <input
            className="input"
            placeholder="e.g. delivery driver — leave blank to match your résumé"
            value={val('TARGET_ROLE')}
            onChange={(e) => set('TARGET_ROLE', e.target.value)}
          />
          <span className="job-meta">
            Jobs demanding licences or credentials you do not have are still skipped.
          </span>
        </label>
      </Step>

      <Step
        n={4}
        title="Where and what pay"
        blurb="Set your preferred work arrangement, location and minimum salary."
        done={done('where')}
      >
        <div className="field">
          <FieldLabel label="Consider these arrangements" help="Choose whether to include remote, hybrid, and on-site jobs." />
          <div className="chips">
            {ARRANGEMENTS.map((a) => (
              <button
                key={a.id}
                className={`chip ${arrangements.includes(a.id) ? 'on' : ''}`}
                onClick={() => toggle('WORK_ARRANGEMENTS', a.id, 'remote,hybrid,onsite')}
              >
                {arrangements.includes(a.id) ? '✓ ' : ''}
                {a.label}
                <span className="chip-hint">{a.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid-2">
          <label className="field">
            <FieldLabel label="My city" help="On-site jobs are only considered when they are located in this city." />
            <select
              className="input"
              value={val('ONSITE_CITY')}
              onChange={(e) => set('ONSITE_CITY', e.target.value)}
            >
              {!AUSTRALIAN_CITIES.includes(val('ONSITE_CITY') as typeof AUSTRALIAN_CITIES[number]) && val('ONSITE_CITY') && (
                <option value={val('ONSITE_CITY')}>{val('ONSITE_CITY')}</option>
              )}
              {AUSTRALIAN_CITIES.map((city) => <option key={city} value={city}>{city}</option>)}
            </select>
          </label>
          <label className="field">
            <FieldLabel label="Minimum annual salary" help="Yearly and daily-rate jobs below this annual amount are skipped." />
            <input
              className="input"
              type="number"
              min="0"
              step="5000"
              value={val('MIN_SALARY')}
              onChange={(e) => set('MIN_SALARY', e.target.value)}
            />
            <span className="job-meta">AUD per year</span>
          </label>
          <label className="field">
            <FieldLabel label="Minimum hourly rate" help="Hourly jobs below this rate are skipped independently of your annual minimum." />
            <input
              className="input"
              type="number"
              min="0"
              step="1"
              value={val('MIN_HOURLY_RATE')}
              onChange={(e) => set('MIN_HOURLY_RATE', e.target.value)}
            />
            <span className="job-meta">AUD per hour · jobs with no salary remain eligible</span>
          </label>
        </div>
      </Step>

      <div className="card step">
        <button className="setup-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
          <span className="step-title">Fine tuning</span>
          <span>{showAdvanced ? '−' : '+'}</span>
        </button>
        <p className="job-meta step-blurb">
          Sensible defaults are already set. Change these only if the results are not what you want.
        </p>
        {showAdvanced && (
          <div className="step-body">
            <div className="grid-2">
              <label className="field">
                <FieldLabel label="Match threshold" help="Jobs scoring below this number are skipped. A higher number gives fewer, closer matches." />
                <input
                  className="input"
                  type="number"
                  value={val('MIN_SCORE')}
                  onChange={(e) => set('MIN_SCORE', e.target.value)}
                />
                <span className="job-meta">Out of 100. Higher means fewer, better matches.</span>
              </label>
              <label className="field">
                <FieldLabel label="Max listing age" help="Job listings older than this many days are skipped." />
                <input
                  className="input"
                  type="number"
                  value={val('MAX_AGE_DAYS')}
                  onChange={(e) => set('MAX_AGE_DAYS', e.target.value)}
                />
                <span className="job-meta">Days since the job was posted.</span>
              </label>
              <label className="field">
                <FieldLabel label="Daily application cap" help="The total number of applications allowed in one day, across all runs." />
                <input
                  className="input"
                  type="number"
                  value={val('MAX_APPS_PER_DAY')}
                  onChange={(e) => set('MAX_APPS_PER_DAY', e.target.value)}
                />
                <span className="job-meta">Keeping this low avoids SEEK verification prompts.</span>
              </label>
              <label className="field">
                <FieldLabel label="Search pages per term" help="How many result pages to check for each search term. More pages take longer." />
                <input
                  className="input"
                  type="number"
                  value={val('PAGES_PER_KEYWORD')}
                  onChange={(e) => set('PAGES_PER_KEYWORD', e.target.value)}
                />
                <span className="job-meta">32 listings per page.</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {dirty && (
        <div className="save-bar">
          <span className="job-meta">You have unsaved changes</span>
          <button className="btn primary" onClick={save}>
            Save changes
          </button>
        </div>
      )}
      {saved && <div className="toast">Settings saved</div>}
    </div>
  );
}
