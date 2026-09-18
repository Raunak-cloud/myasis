import { useEffect, useState } from 'react';
import { startSimulation, type Simulation } from '../simulation';

/**
 * Pick a customer state and see the dashboard as that customer does.
 *
 * Each card says, in the server's own words, what would happen if that
 * customer pressed Start auto apply and what the scheduler would do at their
 * next slot; "Preview" then turns the whole app into that account's view.
 */

function Verdict({ label, verdict }: { label: string; verdict: Simulation['manualStart'] }) {
  return (
    <div className="simulate-verdict">
      <span className="job-meta">{label}</span>
      <span className={verdict ? 'simulate-refused' : 'simulate-allowed'}>
        {verdict ? verdict.error : 'Starts normally.'}
      </span>
    </div>
  );
}

export function SimulateView() {
  const [simulations, setSimulations] = useState<Simulation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/simulations')
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Could not load the scenarios.');
        setSimulations(body.simulations);
      })
      .catch((reason) => setError((reason as Error).message));
  }, []);

  if (error) return <div className="admin-stack"><div className="banner banner-bad">{error}</div></div>;
  if (!simulations) return <div className="admin-stack"><p className="job-meta">Loading…</p></div>;

  const groups = [...new Set(simulations.map((simulation) => simulation.group))];
  return (
    <div className="admin-stack">
      <div className="banner">
        Preview the dashboard as a customer in each state. Nothing is saved and no account is touched: while a preview
        is on, nothing you press is sent, and a reload or “Exit preview” brings your own dashboard back. Your own
        résumés, settings and history stay on screen; only the plan, limits and allowance change.
      </div>
      {groups.map((group) => (
        <section className="card admin-section" key={group}>
          <h3>{group}</h3>
          <div className="simulate-grid">
            {simulations.filter((simulation) => simulation.group === group).map((simulation) => (
              <article className="simulate-card" key={simulation.key}>
                <div className="simulate-card-head">
                  <strong>{simulation.label}</strong>
                  <span className="job-meta">{simulation.billing.totalRemaining} applications left</span>
                </div>
                <p className="dim">{simulation.description}</p>
                {simulation.entitlements.manualRuns
                  ? <Verdict label="Presses Start auto apply" verdict={simulation.manualStart} />
                  : <div className="simulate-verdict"><span className="job-meta">Start button</span><span>None: this plan runs automatically.</span></div>}
                <Verdict label="Next scheduled run" verdict={simulation.scheduledStart} />
                <button className="btn primary" onClick={() => startSimulation(simulation)}>
                  Preview as this customer
                </button>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
