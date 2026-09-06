import { useEffect, useState } from 'react';

export interface CandidateProfile {
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

  useEffect(() => {
    fetch('/api/profile').then((r) => r.json()).then(setP).catch(() => {});
  }, []);

  if (!p) return <div className="job-meta">Loading…</div>;

  const set = <K extends keyof CandidateProfile>(k: K, v: CandidateProfile[K]) => {
    setP({ ...p, [k]: v });
    setDirty(true);
    setSavedAt(null);
  };

  async function save() {
    setSaving(true);
    const res = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    const j = await res.json();
    if (j.profile) setP(j.profile);
    setDirty(false);
    setSaving(false);
    setSavedAt(Date.now());
    onSaved?.();
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
    <div className="profile-form">
      <div className="fieldset">
        <h4 className="fieldset-h">About you</h4>
        <div className="grid-2">
          {text('fullName', 'Full name', { placeholder: 'Jane Smith' })}
          {text('email', 'Email', { type: 'email', placeholder: 'jane@example.com' })}
          {text('phone', 'Phone', { placeholder: '04XX XXX XXX' })}
          {text('highestQualification', 'Highest qualification', {
            placeholder: 'Bachelor of Information Technology',
          })}
        </div>
        <div className="grid-3">
          {text('suburb', 'Suburb', { placeholder: 'Parramatta' })}
          {text('state', 'State', { placeholder: 'NSW' })}
          {text('postcode', 'Postcode', { placeholder: '2150' })}
        </div>
      </div>

      <div className="fieldset">
        <h4 className="fieldset-h">Work eligibility</h4>
        <p className="job-meta fieldset-blurb">
          Almost every application asks this. Answering it here means a run doesn't have to stop and
          ask you.
        </p>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Work rights</span>
            <select className="input" value={p.workRights} onChange={(e) => set('workRights', e.target.value)}>
              <option value="">Select…</option>
              {WORK_RIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          {text('noticePeriod', 'Notice period', { placeholder: '2 weeks' })}
          {text('expectedSalary', 'Expected salary', {
            placeholder: '$90,000+',
            hint: 'A range is fine. Used to answer salary questions.',
          })}
          {text('willingToTravel', 'Willing to travel', {
            optional: true,
            placeholder: 'Up to 1 hour',
          })}
        </div>
        <div className="check-row">
          <label className="check">
            <input
              type="checkbox"
              checked={p.hasDriverLicence}
              onChange={(e) => set('hasDriverLicence', e.target.checked)}
            />
            <span>I hold a current driver licence</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={p.willingToRelocate}
              onChange={(e) => set('willingToRelocate', e.target.checked)}
            />
            <span>I'm willing to relocate</span>
          </label>
        </div>
      </div>

      <div className="fieldset">
        <h4 className="fieldset-h">Your experience</h4>
        <p className="job-meta fieldset-blurb">
          Used to judge whether a job is a genuine fit and to write cover letters. Be accurate —
          nothing here will be exaggerated on your behalf.
        </p>
        {text('headline', 'Professional headline', {
          optional: true,
          placeholder: 'Full-stack developer · React, Node, TypeScript',
        })}
        <label className="field">
          <span className="field-label">Experience summary</span>
          <textarea
            className="input"
            rows={4}
            placeholder="e.g. 4 years building web applications, 2 of them freelance. Led delivery of…"
            value={p.experienceSummary}
            onChange={(e) => set('experienceSummary', e.target.value)}
          />
          <span className="job-meta">A short, honest paragraph. Your résumé carries the detail.</span>
        </label>
        <label className="field">
          <span className="field-label">Key skills</span>
          <textarea
            className="input mono-input"
            rows={2}
            placeholder="JavaScript, TypeScript, React, Node.js, PostgreSQL"
            value={p.skills}
            onChange={(e) => set('skills', e.target.value)}
          />
          <span className="job-meta">Comma separated. Drives how jobs are scored.</span>
        </label>
      </div>

      <details className="fieldset collapsible">
        <summary className="fieldset-h">Links and optional details</summary>
        <div className="grid-2 fieldset-inner">
          {text('linkedin', 'LinkedIn', { optional: true, placeholder: 'https://linkedin.com/in/…' })}
          {text('portfolio', 'Portfolio or GitHub', { optional: true, placeholder: 'https://…' })}
          {text('pronouns', 'Pronouns', { optional: true })}
          {text('referralSource', 'How you heard about roles', {
            optional: true,
            hint: 'Default answer for "how did you hear about us".',
          })}
          {text('gender', 'Gender', { optional: true, hint: 'Only used if a form explicitly asks.' })}
          {text('disability', 'Disability', {
            optional: true,
            hint: 'Only used if a form explicitly asks.',
          })}
        </div>
      </details>

      <div className="profile-save">
        <button className="btn primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
        {savedAt && <span className="job-meta">Saved</span>}
        {dirty && !saving && <span className="job-meta">Unsaved changes</span>}
      </div>
    </div>
  );
}
