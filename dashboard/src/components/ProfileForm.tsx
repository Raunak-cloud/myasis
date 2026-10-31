import { useCallback, useEffect, useRef, useState } from 'react';
import { AutoGrowTextarea } from './AutoGrowTextarea';
import { annualSalaryAmount } from '../salary';

interface CandidateProfile {
  fullName: string;
  email: string;
  phone: string;
  suburb: string;
  state: string;
  postcode: string;
  workRights: string;
  hasDriverLicence: boolean;
  willingToRelocate: boolean;
  willingToTravel: string;
  headline: string;
  experienceSummary: string;
  skills: string;
  highestQualification: string;
  expectedSalary: string;
  noticePeriod: string;
  linkedin: string;
  portfolio: string;
  pronouns: string;
  gender: string;
  disability: string;
  referralSource: string;
}

const WORK_RIGHTS = [
  'Citizen',
  'Permanent resident',
  'Visa with full work rights',
  'Visa with limited work rights',
  'Require sponsorship',
];

/**
 * The candidate's own details.
 *
 * These answer the questions employers ask on every application, so filling
 * this in is what lets a run complete instead of stopping to ask. Optional
 * fields are marked as such — a half-filled form should still be usable.
 */
export function ProfileForm({ onSaved }: { onSaved?: () => void }) {
  const [p, setP] = useState<CandidateProfile | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editVersion = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const response = await fetch('/api/profile', { signal });
      const profile = await response.json().catch(() => null);
      if (!response.ok || !profile || typeof profile.fullName !== 'string' || typeof profile.expectedSalary !== 'string') throw new Error();
      if (!signal?.aborted) setP(profile);
    } catch {
      if (!signal?.aborted) setError('Could not load your details. Please try again.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => { await load(controller.signal); })();
    return () => controller.abort();
  }, [load]);

  if (!p) return error
    ? <div className="job-meta" role="alert">{error} <button type="button" className="btn" onClick={() => void load()}>Retry</button></div>
    : <div className="job-meta">Loading…</div>;

  const set = <K extends keyof CandidateProfile>(k: K, v: CandidateProfile[K]) => {
    setP({ ...p, [k]: v });
    editVersion.current++;
    setDirty(true);
    setSavedAt(null);
    setError(null);
  };

  async function save() {
    if (saving) return;
    if (annualSalaryAmount(p?.expectedSalary) === null) {
      setError('Enter one expected annual base salary amount in AUD, excluding superannuation.');
      return;
    }
    setSaving(true);
    setError(null);
    const submittedVersion = editVersion.current;
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.profile) throw new Error(j?.error ?? 'Could not save your details. Please try again.');
      if (editVersion.current === submittedVersion) {
        setP(j.profile);
        setDirty(false);
        setSavedAt(Date.now());
      }
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your details. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const text = (
    k: keyof CandidateProfile,
    label: string,
    opts: { placeholder?: string; optional?: boolean; hint?: string; type?: string } = {},
  ) => (
    <label className="field" key={k}>
      <span className="field-label">
        {label} {opts.optional && <span className="optional">optional</span>}
      </span>
      <input
        className="input"
        type={opts.type ?? 'text'}
        placeholder={opts.placeholder}
        value={String(p[k] ?? '')}
        onChange={(e) => set(k, e.target.value as never)}
      />
      {opts.hint && <span className="job-meta">{opts.hint}</span>}
    </label>
  );

  return (
    <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="fieldset">
        <h4 className="fieldset-h">About you</h4>
        <div className="grid-2">
          {text('fullName', 'Full name', { placeholder: 'Jane Smith' })}
          {text('email', 'Email', { type: 'email', placeholder: 'jane@example.com' })}
          {text('phone', 'Phone', { placeholder: '04XX XXX XXX' })}
          {text('highestQualification', 'Highest qualification', { placeholder: 'Bachelor of IT, UTS' })}
        </div>
        <div className="grid-3">
          {text('suburb', 'Suburb', { placeholder: 'Parramatta' })}
          {text('state', 'State', { placeholder: 'NSW' })}
          {text('postcode', 'Postcode', { placeholder: '2150' })}
        </div>
      </div>

      <div className="fieldset">
        <h4 className="fieldset-h">Work</h4>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Australian work rights</span>
            <select className="input" value={p.workRights} onChange={(e) => set('workRights', e.target.value)}>
              <option value="">Select…</option>
              {WORK_RIGHTS.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          {text('noticePeriod', 'Notice period', { placeholder: '2 weeks' })}
          <label className="field">
            <span className="field-label">Expected annual base salary (AUD) <span className="optional">required</span></span>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              required
              placeholder="e.g. 150000"
              value={p.expectedSalary}
              onChange={(event) => set('expectedSalary', event.target.value)}
              aria-describedby="expected-salary-help"
            />
            <span className="job-meta" id="expected-salary-help">One yearly amount, excluding superannuation. Required before any run. This answers employer questions; your minimum salary filter is separate.</span>
          </label>
        </div>
        <div className="check-row">
          <label className="check">
            <input type="checkbox" checked={p.hasDriverLicence} onChange={(e) => set('hasDriverLicence', e.target.checked)} />
            <span>Driver licence</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={p.willingToRelocate} onChange={(e) => set('willingToRelocate', e.target.checked)} />
            <span>Willing to relocate</span>
          </label>
        </div>
      </div>

      <div className="fieldset">
        <h4 className="fieldset-h">Experience</h4>
        {text('headline', 'Headline', { optional: true, placeholder: 'Full-stack developer · React, Node, TypeScript' })}
        <label className="field">
          <span className="field-label">Summary</span>
          <AutoGrowTextarea
            className="input"
            rows={3}
            placeholder="A few honest sentences, e.g. 4 years building web apps, 2 freelance."
            value={p.experienceSummary}
            onChange={(e) => set('experienceSummary', e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Skills</span>
          <AutoGrowTextarea
            className="input"
            rows={2}
            placeholder="Comma separated, e.g. JavaScript, React, Node.js, SQL"
            value={p.skills}
            onChange={(e) => set('skills', e.target.value)}
          />
        </label>
      </div>

      <details className="fieldset collapsible">
        <summary className="fieldset-h">More <span className="optional">optional</span></summary>
        <p className="job-meta fieldset-blurb">Gender and disability are only used when a form asks.</p>
        <div className="grid-2 fieldset-inner">
          {text('linkedin', 'LinkedIn', { placeholder: 'https://linkedin.com/in/…' })}
          {text('portfolio', 'Portfolio or GitHub', { placeholder: 'https://…' })}
          {text('willingToTravel', 'Willing to travel', { placeholder: 'Up to 1 hour' })}
          {text('referralSource', 'How you heard about jobs', { placeholder: 'SEEK' })}
          {text('pronouns', 'Pronouns')}
          {text('gender', 'Gender')}
          {text('disability', 'Disability')}
        </div>
      </details>

      <div className="profile-save">
        <button className="btn primary" type="submit" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && <span className="job-meta">Saved</span>}
        {dirty && !saving && <span className="job-meta">Unsaved changes</span>}
        {error && <span className="job-meta" role="alert">{error}</span>}
      </div>
    </form>
  );
}
