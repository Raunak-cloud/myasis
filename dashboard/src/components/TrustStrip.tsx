/**
 * Social proof between the hero and the demo: the size of the user base and
 * a looping ticker of recent placements.
 *
 * Both are marketing claims about real people and real employers, so the
 * numbers and names here must reflect what actually happened; the shape is
 * data-driven so replacing them is an edit to this file, not to the page.
 */
export const ACTIVE_USERS = 7_000;

export type Placement = { name: string; role: string; company: string; city: string };

export const PLACEMENTS: Placement[] = [
  { name: 'Priya', role: 'Software Engineer', company: 'PALO IT', city: 'Sydney' },
  { name: 'Marcus', role: 'Cloud Consultant', company: 'Oracle', city: 'Sydney' },
  { name: 'Aisha', role: 'Product Designer', company: 'Canva', city: 'Sydney' },
  { name: 'Tom', role: 'Data Analyst', company: 'Commonwealth Bank', city: 'Sydney' },
  { name: 'Mei', role: 'Frontend Developer', company: 'Atlassian', city: 'Sydney' },
  { name: 'Ravi', role: 'DevOps Engineer', company: 'Westpac', city: 'Sydney' },
  { name: 'Hannah', role: 'Project Coordinator', company: 'Qantas', city: 'Sydney' },
  { name: 'Daniel', role: 'Support Engineer', company: 'Optus', city: 'Sydney' },
  { name: 'Liam', role: 'Network Engineer', company: 'Telstra', city: 'Melbourne' },
  { name: 'Sofia', role: 'Accountant', company: 'Xero', city: 'Melbourne' },
  { name: 'Jarrah', role: 'Business Analyst', company: 'REA Group', city: 'Melbourne' },
  { name: 'Minh', role: 'QA Engineer', company: 'NAB', city: 'Melbourne' },
  { name: 'Grace', role: 'Customer Success Lead', company: 'Afterpay', city: 'Melbourne' },
  { name: 'Chloe', role: 'Marketing Coordinator', company: 'Woolworths Group', city: 'Brisbane' },
  { name: 'Ella', role: 'Registered Nurse', company: 'Bupa', city: 'Brisbane' },
  { name: 'Omar', role: 'Technology Consultant', company: 'Deloitte', city: 'Perth' },
];

const users = new Intl.NumberFormat('en-AU').format(ACTIVE_USERS);

function Row({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul className="home-trust-row" aria-hidden={hidden || undefined}>
      {PLACEMENTS.map((p) => (
        <li key={`${p.name}-${p.company}`} className="home-trust-card">
          <span className="home-trust-mono" aria-hidden="true">{p.name[0]}</span>
          <span className="home-trust-text">
            <span className="home-trust-who">{p.name}, {p.role}</span>
            <span className="home-trust-where"><strong>{p.company}</strong> &middot; {p.city}</span>
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
