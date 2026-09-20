/**
 * Social proof between the hero and the demo: the size of the user base and
 * a looping ticker showing the variety of employers people can search.
 *
 * The employers are representative examples, not placement claims. The shape
 * is data-driven so changing the mix is an edit to this file, not to the page.
 */
export const ACTIVE_USERS = 7_000;

export type Placement = { company: string; city: string };

export const PLACEMENTS: Placement[] = [
  { company: 'Coles', city: 'Melbourne' },
  { company: 'Chemist Warehouse', city: 'Melbourne' },
  { company: 'Canva', city: 'Sydney' },
  { company: 'Commonwealth Bank', city: 'Sydney' },
  { company: 'Ramsay Health Care', city: 'Sydney' },
  { company: 'Westpac', city: 'Sydney' },
  { company: 'Qantas', city: 'Sydney' },
  { company: 'MECCA', city: 'Melbourne' },
  { company: 'Telstra', city: 'Melbourne' },
  { company: 'Bunnings', city: 'Melbourne' },
  { company: 'Australia Post', city: 'Melbourne' },
  { company: 'NAB', city: 'Melbourne' },
  { company: 'Sephora Australia', city: 'Sydney' },
  { company: 'Woolworths Group', city: 'Brisbane' },
  { company: 'Bupa', city: 'Brisbane' },
  { company: 'Wesfarmers', city: 'Perth' },
];

const users = new Intl.NumberFormat('en-AU').format(ACTIVE_USERS);

function Row({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul className="home-trust-row" aria-hidden={hidden || undefined}>
      {PLACEMENTS.map((p) => (
        <li key={p.company} className="home-trust-card">
          <span className="home-trust-company">{p.company}</span>
          <span className="home-trust-city">{p.city}</span>
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
          <p className="home-trust-label">explore roles across employers including</p>
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
