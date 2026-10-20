import { useEffect, useState } from 'react';

export function DeleteAccount() {
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    setError(''); setBusy(true);
    try {
      const response = await fetch('/api/account');
      const account = await response.json();
      if (!response.ok || typeof account.email !== 'string') throw new Error('Could not load your account. Please retry.');
      setEmail(account.email); setConfirmEmail(''); setConfirming(true);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmEmail }) });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error || 'Your account could not be deleted. Please retry.');
      window.location.assign('/?account=deleted');
    } catch (error) { setError((error as Error).message); setBusy(false); }
  }

  useEffect(() => {
    if (confirming) document.getElementById('delete-account-email')?.focus();
  }, [confirming]);

  return <section className="card account-deletion" aria-labelledby="delete-account-heading">
    <h3 id="delete-account-heading" className="step-title">Delete account</h3>
    <p className="job-meta">Permanently delete your Owtomate account and its stored data, including your profile, resumes, documents, saved answers, application history and browser sessions.</p>
    <p className="job-meta">This cannot be undone. Unused applications and passes will be lost. Backup copies expire within 30 days. Applications already sent to employers and accounts on employer websites stay with those websites.</p>
    {!confirming && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void open()}>{busy ? 'Loading account…' : 'Delete my account'}</button>}
    {confirming && <div role="alertdialog" aria-labelledby="delete-account-confirm-title" aria-describedby="delete-account-confirm-help">
      <h4 id="delete-account-confirm-title">Permanently delete your account?</h4>
      <p id="delete-account-confirm-help" className="job-meta">Type {email} to confirm. Any active application run will be stopped.</p>
      <label className="field">Your account email
        <input id="delete-account-email" className="input" type="email" autoComplete="off" value={confirmEmail} disabled={busy} onChange={event => setConfirmEmail(event.target.value)} />
      </label>
      <div className="confirm-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => { setConfirming(false); setConfirmEmail(''); setError(''); }}>Cancel</button>
        <button type="button" className="btn btn-danger-solid" disabled={busy || confirmEmail.trim().toLowerCase() !== email.toLowerCase()} onClick={() => void remove()}>{busy ? 'Deleting account…' : 'Permanently delete account'}</button>
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
