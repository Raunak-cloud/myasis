import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../adminApi';

/**
 * The installation's configuration as a form.
 *
 * Every field maps to one line of seek-bot/.env on the server. Plain values
 * are shown as they are; a secret is shown only as "set" with its length, and
 * typing into its box replaces it. Nothing is written until Save, and Save
 * writes everything at once or nothing at all.
 */

type Kind = 'text' | 'secret' | 'number' | 'boolean' | 'url' | 'choice';

interface EnvEntry {
  key: string;
  label: string;
  help: string;
  kind: Kind;
  value: string | null;
  set: boolean;
  length: number;
  hint: string | null;
  locked: string | null;
  shadowed: boolean;
  restart: boolean;
  known: boolean;
  options?: Array<{ value: string; label: string }>;
}

interface GroupBanner {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

interface EnvReport {
  groups: Array<{ key: string; title: string; note?: string; banner?: GroupBanner; entries: EnvEntry[] }>;
  hidden: number;
  restartPending: boolean;
  file: string;
}

/** What the operator has typed but not yet saved, by key. */
type Drafts = Record<string, string>;

function Field({ entry, draft, onChange }: { entry: EnvEntry; draft: string | undefined; onChange: (value: string | undefined) => void }) {
  const disabled = Boolean(entry.locked) || entry.shadowed;
  const dirty = draft !== undefined;

  if (entry.kind === 'choice') {
    const current = draft ?? entry.value ?? '';
    const listed = entry.options?.some((option) => option.value === current) ?? false;
    return (
      <select
        className="input"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === (entry.value ?? '') ? undefined : event.target.value)}
        aria-label={entry.label}
      >
        {!listed && <option value={current}>{current || 'Not set'}</option>}
        {entry.options?.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  if (entry.kind === 'boolean') {
    const current = draft ?? entry.value ?? '';
    return (
      <select
        className="input"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === (entry.value ?? '') ? undefined : event.target.value)}
        aria-label={entry.label}
      >
        <option value="">Not set</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  }

  if (entry.kind === 'secret') {
    const removing = dirty && draft === '';
    const kindWord = entry.hint?.includes('live') ? 'live key' : entry.hint?.includes('test') ? 'test key' : null;
    return (
      <div className="env-secret">
        <span className={`env-status ${entry.set ? 'on' : ''}`}>
          {removing
            ? 'Will be removed on save'
            : entry.set
              ? `Set${kindWord ? ` · ${kindWord}` : ''}${entry.hint ? ` · ${entry.hint}…` : ''} · ${entry.length} characters`
              : 'Not set'}
        </span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled}
          placeholder={entry.set ? 'Type a new value to replace it' : 'Enter a value'}
          value={draft ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
          aria-label={entry.label}
        />
        {entry.set && !disabled && (
          <button
            type="button"
            className={`btn btn-small ${removing ? 'btn-danger' : ''}`}
            onClick={() => onChange(removing ? undefined : '')}
            title="Remove this value on save"
          >
            {removing ? 'Keep it' : 'Remove'}
          </button>
        )}
      </div>
    );
  }

  return (
    <input
      className="input"
      type={entry.kind === 'number' ? 'text' : entry.kind === 'url' ? 'url' : 'text'}
      inputMode={entry.kind === 'number' ? 'decimal' : undefined}
      spellCheck={false}
      disabled={disabled}
      value={draft ?? entry.value ?? ''}
      onChange={(event) => onChange(event.target.value === (entry.value ?? '') ? undefined : event.target.value)}
      aria-label={entry.label}
    />
  );
}

export function EnvView() {
  const [data, setData] = useState<EnvReport | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(() => {
    api<EnvReport>('/env')
      .then((report) => {
        setData(report);
        setError(null);
      })
      .catch((reason) => setError((reason as Error).message));
  }, []);
  useEffect(load, [load]);

  const dirtyKeys = useMemo(() => Object.keys(drafts), [drafts]);
  const setDraft = (key: string, value: string | undefined) =>
    setDrafts((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ ok: true; changed: string[]; restartNeeded: boolean }>('/env', { method: 'POST', json: { changes: drafts } });
      setDrafts({});
      setNotice(
        result.changed.length === 0
          ? 'Nothing changed.'
          : `Saved ${result.changed.length} setting${result.changed.length === 1 ? '' : 's'}: ${result.changed.join(', ')}.${
              result.restartNeeded ? ' One of them takes effect after a restart.' : ' Runs pick this up from their next start.'
            }`,
      );
      load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    if (!window.confirm('Restart the dashboard now? Everyone loses their page for a few seconds. Refused while a run is going.')) return;
    setRestarting(true);
    setError(null);
    try {
      await api('/env/restart', { method: 'POST' });
      setNotice('Restarting. This page reconnects on its own.');
      // pm2 brings it back in a few seconds; keep asking until it answers.
      const started = Date.now();
      const poll = window.setInterval(() => {
        fetch('/api/admin/env', { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) return;
            window.clearInterval(poll);
            setRestarting(false);
            setNotice('Back up.');
            load();
          })
          .catch(() => {
            if (Date.now() - started > 60_000) {
              window.clearInterval(poll);
              setRestarting(false);
              setError('The dashboard has not come back after a minute. Check pm2 on the server.');
            }
          });
      }, 2_000);
    } catch (reason) {
      setRestarting(false);
      setError((reason as Error).message);
    }
  };

  if (!data) {
    return <div className="admin-stack">{error ? <div className="banner banner-bad">{error}</div> : <p className="job-meta">Loading…</p>}</div>;
  }

  return (
    <div className="admin-stack env-page">
      <p className="job-meta">
        Each field is one line of <code>{data.file}</code>. Secrets are never shown back; type into one to replace it.
        {data.hidden > 0 && ` ${data.hidden} per-account settings in that file are not listed, because every run overrides them with the account's own.`}
      </p>

      {error && <div className="banner banner-bad">{error}</div>}
      {notice && <div className="banner">{notice}</div>}
      {data.restartPending && !restarting && (
        <div className="banner">
          A setting that is read at start-up has changed. It takes effect after a restart.
          <button className="btn btn-small" onClick={restart} style={{ marginLeft: 10 }}>Restart dashboard</button>
        </div>
      )}

      {data.groups.map((group) => (
        <section className="card env-group" key={group.key}>
          <div className="env-group-head">
            <h3>{group.title}</h3>
            {group.note && <p className="job-meta">{group.note}</p>}
          </div>
          {group.banner && <div className={`env-banner tone-${group.banner.tone}`}>{group.banner.text}</div>}
          <div className="env-rows">
            {group.entries.map((entry) => {
              const draft = drafts[entry.key];
              const dirty = draft !== undefined;
              return (
                <div className={`env-row ${dirty ? 'dirty' : ''}`} key={entry.key}>
                  <div className="env-meta">
                    <label className="field-label" htmlFor={`env-${entry.key}`}>{entry.label}</label>
                    <code className="env-key">{entry.key}</code>
                    {entry.help && <span className="job-meta">{entry.help}</span>}
                    <span className="admin-badges">
                      {entry.restart && <span className="admin-board">restart to apply</span>}
                      {entry.shadowed && <span className="admin-board">set by the server process</span>}
                      {entry.locked && <span className="admin-board">read only</span>}
                      {!entry.known && <span className="admin-board">not described</span>}
                    </span>
                    {entry.locked && <span className="job-meta">{entry.locked}</span>}
                    {entry.shadowed && !entry.locked && (
                      <span className="job-meta">Carried by pm2 from ecosystem.config.cjs, so a change here would be ignored.</span>
                    )}
                  </div>
                  <div className="env-control">
                    <Field entry={entry} draft={draft} onChange={(value) => setDraft(entry.key, value)} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <div className="env-bar" role="region" aria-label="Unsaved changes">
        <span className="job-meta">
          {dirtyKeys.length === 0 ? 'No unsaved changes.' : `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? '' : 's'}: ${dirtyKeys.join(', ')}`}
        </span>
        <div className="env-bar-actions">
          <button className="btn" onClick={() => setDrafts({})} disabled={dirtyKeys.length === 0 || saving}>Discard</button>
          <button className="btn primary" onClick={save} disabled={dirtyKeys.length === 0 || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
