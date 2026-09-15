import { useCallback, useEffect, useState } from 'react';
import { aud, HUMANIZER_NOTE, PAID_PLANS, PLAN_PRESENTATION, type PaidPlanKey } from '../pricing';

interface BillingStatus {
  configured: boolean;
  free: {
    allowance: number;
    used: number;
    remaining: number;
    resetsAt: string;
  };
  paid: {
    remaining: number;
    expiresAt: string | null;
    hasActivePass: boolean;
    hasActiveIntensivePass: boolean;
  };
  totalRemaining: number;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(value));
}

export function PricingPanel() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<PaidPlanKey | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await fetch('/api/billing/status');
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not load your application allowance.');
    setStatus(body);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    const sessionId = params.get('session_id');

    const finish = async () => {
      try {
        if (payment === 'success' && sessionId) {
          setNotice({ kind: 'warn', text: 'Confirming your payment…' });
          const response = await fetch('/api/billing/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Could not confirm the payment.');
          setStatus(body.status);
          setNotice({ kind: 'ok', text: `${body.applications} applications were added to your account.` });
        } else {
          await loadStatus();
          if (payment === 'cancelled') {
            setNotice({ kind: 'warn', text: 'Checkout was cancelled. Nothing was charged.' });
          }
        }
      } catch (error) {
        setNotice({ kind: 'bad', text: (error as Error).message });
      } finally {
        setLoading(false);
        if (payment) {
          window.history.replaceState({}, '', `${window.location.pathname}?tab=pricing`);
        }
      }
    };

    void finish();
  }, [loadStatus]);

  const buy = async (planKey: PaidPlanKey) => {
    setBuying(planKey);
    setNotice(null);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey }),
      });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.error || 'Could not open checkout.');
      window.location.assign(body.url);
    } catch (error) {
      setNotice({ kind: 'bad', text: (error as Error).message });
      setBuying(null);
    }
  };

  const checkoutDisabled = loading || !status?.configured || buying !== null;

  return (
    <div className="pricing-page">
      {notice && <div className={`pricing-notice ${notice.kind}`} role="status">{notice.text}</div>}

      {status && (
        <section className="allowance-card" aria-label="Application allowance">
          <div>
            <span className="allowance-label">Available now</span>
            <strong>{status.totalRemaining}</strong>
            <span>successful applications</span>
          </div>
          <div className="allowance-breakdown">
            <p>
              <strong>{status.free.remaining}</strong> of {status.free.allowance} free applications left
              <span>Resets {dateLabel(status.free.resetsAt)}</span>
            </p>
            <p>
              <strong>{status.paid.remaining}</strong> paid applications left
              <span>{status.paid.expiresAt ? `Valid until ${dateLabel(status.paid.expiresAt)}` : 'No active pass'}</span>
            </p>
          </div>
        </section>
      )}

      {!loading && status && !status.configured && (
        <div className="pricing-notice warn">
          Payments are not configured yet. Add your Stripe keys to enable secure checkout.
        </div>
      )}

      <section className="pricing-intro">
        <span className="pricing-kicker">Plans &amp; pricing</span>
        <h2>Choose how you want Myasis to run</h2>
        <p>Use the automatic schedule, or choose Intensive when you want to start and fine-tune each run yourself.</p>
      </section>

      <div className="pricing-grid">
        <article className="pricing-card">
          <header className="pricing-card-head">
            <span className="pricing-plan-label">{PLAN_PRESENTATION.free.label}</span>
            <h3>Free</h3>
            <p className="pricing-plan-copy">{PLAN_PRESENTATION.free.description}</p>
          </header>
          <p className="pricing-price"><strong>A$0</strong><span>no card needed</span></p>
          <button className="btn pricing-cta" disabled>Included with your account</button>
          <div className="pricing-card-divider" />
          <span className="pricing-includes">What you get</span>
          <ul className="pricing-features">
            {PLAN_PRESENTATION.free.features.map((feature) => <li key={feature}>{feature}</li>)}
          </ul>
        </article>

        {(['job-search-pass', 'intensive-pass'] as const).map((key) => {
          const plan = PAID_PLANS[key];
          const presentation = PLAN_PRESENTATION[key];
          const recommended = key === 'job-search-pass';
          return (
            <article className={`pricing-card ${recommended ? 'recommended' : ''}`} key={key}>
              {recommended && <span className="pricing-popular">Most popular</span>}
              <header className="pricing-card-head">
                <span className="pricing-plan-label">{presentation.label}</span>
                <h3>{plan.name}</h3>
                <p className="pricing-plan-copy">{presentation.description}</p>
              </header>
              <p className="pricing-price"><strong>{aud(plan.priceCents)}</strong><span>one-time payment · valid 30 days</span></p>
              <button
                className={`btn pricing-cta ${recommended ? 'primary' : ''}`}
                disabled={checkoutDisabled}
                onClick={() => void buy(key)}
              >
                {buying === key ? 'Opening checkout…' : `Choose ${plan.name}`}
              </button>
              <div className="pricing-card-divider" />
              <span className="pricing-includes">What you get</span>
              <ul className="pricing-features">
                {presentation.features.map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
            </article>
          );
        })}
      </div>
      <p className="job-meta pricing-footnote">{HUMANIZER_NOTE}</p>

      <section className="topup-card">
        <div>
          <span className="pricing-plan-label">Keep your current plan</span>
          <h3>{PAID_PLANS['application-top-up'].name}</h3>
          <p>
            Add {PAID_PLANS['application-top-up'].applications} successful applications to your balance, valid for{' '}
            {PAID_PLANS['application-top-up'].validDays} days.
          </p>
        </div>
        <div className="topup-action">
          <p className="pricing-price"><strong>{aud(PAID_PLANS['application-top-up'].priceCents)}</strong><span>one payment</span></p>
          <button
            className="btn pricing-cta"
            disabled={checkoutDisabled}
            onClick={() => void buy('application-top-up')}
          >
            {buying === 'application-top-up' ? 'Opening checkout…' : 'Add 50 applications'}
          </button>
        </div>
      </section>

      <section className="pricing-explainer">
        <h2>How usage works</h2>
        <div>
          <article>
            <strong>Only successful submissions count</strong>
            <p>Skipped jobs, failed forms, off-platform listings and items needing your attention do not use your allowance.</p>
          </article>
          <article>
            <strong>Passes last one month</strong>
            <p>Your applications remain available until the pass expires. There is no automatic renewal.</p>
          </article>
          <article>
            <strong>Top-ups add capacity</strong>
            <p>A top-up adds applications without changing how your current plan runs.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
