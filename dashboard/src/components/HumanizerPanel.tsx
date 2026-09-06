import { useEffect, useState } from 'react';

type RewriteStatus = {
  configured: boolean;
  online: boolean;
  error?: string;
};

export function HumanizerPanel() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<RewriteStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function checkStatus() {
    try {
      const response = await fetch('/api/humanizer');
      setStatus(await response.json());
    } catch {
      setStatus({ configured: false, online: false, error: 'Dashboard is unavailable.' });
    }
  }

  useEffect(() => {
    void checkStatus();
  }, []);

  async function run() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch('/api/humanizer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Rewrite failed.');
      setOutput(body.text ?? '');
      setStatus({ configured: true, online: true });
    } catch (reason) {
      setError((reason as Error).message);
      void checkStatus();
    } finally {
      setLoading(false);
    }
  }

  async function generateSample() {
    if (generating || loading) return;
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch('/api/humanizer/sample', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not generate a sample.');
      setInput(body.text ?? '');
      setOutput('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  async function copyOutput() {
    if (!output) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const clear = () => {
    setInput('');
    setOutput('');
    setError(null);
  };
  const inputWords = input.trim() ? input.trim().split(/\s+/).length : 0;
  const outputWords = output.trim() ? output.trim().split(/\s+/).length : 0;

  return (
    <section className="humanizer-page">
      <div className="model-bar">
        <span className={`status-dot ${status?.online ? 'online' : ''}`} aria-hidden="true" />
        <span>{status?.online ? 'Rewriter ready' : status ? 'Rewriter offline' : 'Checking rewriter…'}</span>
        {status && !status.online && <button className="btn" onClick={checkStatus}>Retry</button>}
      </div>

      {status && !status.online && (
        <div className="banner banner-bad">
          {status.error ?? 'The rewriting service is offline.'} Start it with <code>npm run humanizer</code>.
        </div>
      )}
      {error && <div className="banner banner-bad">{error}</div>}

      <div className="humanizer-grid">
        <div className="card humanizer-editor">
          <div className="humanizer-editor-head">
            <label htmlFor="humanizer-input">Original</label>
            <span className="job-meta">{inputWords} words</span>
          </div>
          <textarea
            id="humanizer-input"
            className="input humanizer-textarea"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Paste text to rewrite…"
            spellCheck
          />
          <div className="humanizer-actions">
            <button className="btn primary lg" disabled={!input.trim() || loading} onClick={run}>
              {loading ? 'Rewriting…' : 'Rewrite'}
            </button>
            <button className="btn" disabled={generating || loading} onClick={generateSample}>
              {generating ? 'Generating…' : 'Generate sample'}
            </button>
            <button className="btn" disabled={!input && !output} onClick={clear}>Clear</button>
          </div>
        </div>

        <div className="card humanizer-editor">
          <div className="humanizer-editor-head">
            <label htmlFor="humanizer-output">Result</label>
            <span className="job-meta">{outputWords} words</span>
          </div>
          <textarea
            id="humanizer-output"
            className="input humanizer-textarea"
            value={output}
            readOnly
            placeholder="The rewritten text will appear here."
          />
          <div className="humanizer-actions">
            <button className="btn" disabled={!output} onClick={copyOutput}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      </div>

      <p className="job-meta humanizer-note">Review important details before using the rewrite.</p>
    </section>
  );
}
