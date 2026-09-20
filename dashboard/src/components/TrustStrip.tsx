/**
 * Social proof between the hero and the demo: the size of the user base and
 * a looping ticker of recent placements.
 *
 * Both are marketing claims about real employers, so the numbers and names
 * here must reflect what actually happened; the shape is data-driven so
 * replacing them is an edit to this file, not to the page. The ticker names
 * the employer and the city only — no person, no role — so a card is two
 * short lines and nobody's placement is pinned to a name.
 */
export const ACTIVE_USERS = 7_000;

export type Placement = { company: string; city: string };

export const PLACEMENTS: Placement[] = [
  { company: 'PALO IT', city: 'Sydney' },
  { company: 'Oracle', city: 'Sydney' },
  { company: 'Canva', city: 'Sydney' },
  { company: 'Commonwealth Bank', city: 'Sydney' },
  { company: 'Atlassian', city: 'Sydney' },
  { company: 'Westpac', city: 'Sydney' },
  { company: 'Qantas', city: 'Sydney' },
  { company: 'Optus', city: 'Sydney' },
  { company: 'Telstra', city: 'Melbourne' },
  { company: 'Xero', city: 'Melbourne' },
  { company: 'REA Group', city: 'Melbourne' },
  { company: 'NAB', city: 'Melbourne' },
  { company: 'Afterpay', city: 'Melbourne' },
  { company: 'Woolworths Group', city: 'Brisbane' },
  { company: 'Bupa', city: 'Brisbane' },
  { company: 'Deloitte', city: 'Perth' },
];

const users = new Intl.NumberFormat('en-AU').format(ACTIVE_USERS);

function Row({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul className="home-trust-row" aria-hidden={hidden || undefined}>
      {PLACEMENTS.map((p) => (
        <li key={p.company} className="home-trust-card">
          <span className="home-trust-mono" aria-hidden="true">{p.company[0]}</span>
          <span className="home-trust-text">
            <span className="home-trust-company">{p.company}</span>
            <span className="home-trust-city">{p.city}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TrustStrip() {
  return (
    <section className="home-trust" aria-labelledby="trust-heading">
      <div className="home-width home-trust-inner">
        <p id="trust-heading" className="home-trust-stat">
          <span className="home-trust-kicker">trusted by</span>
          <span className="home-trust-count">{users}</span>
          <span className="home-trust-kicker">active users</span>
        </p>
        <div className="home-trust-ticker">
          <p className="home-trust-label">recently landed jobs at</p>
          {/* The row is rendered twice so the loop has no visible seam; the copy is hidden from assistive tech. */}
          <div className="home-trust-window">
            <div className="home-trust-track">
              <Row />
              <Row hidden />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
