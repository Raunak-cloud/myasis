import { useCallback, useEffect, useState } from 'react';
import { aud, PAID_PLANS, type PaidPlanKey } from '../pricing';

interface BillingStatus {
  configured: boolean;
  free: {
    allowance: number;
    used: number;
    remaining: number;
    resetsAt: string;
  };
  rehearsals: {
    allowance: number;
    used: number;
    remaining: number;
    unlimited: boolean;
  };
  paid: {
    remaining: number;
    expiresAt: string | null;
    hasActivePass: boolean;
    hasActiveIntensivePass: boolean;
  };
  totalRemaining: number;
}

const PASS_FEATURES: Record<Exclude<PaidPlanKey, 'application-top-up'>, string[]> = {
  'job-search-pass': [
    '100 successful applications',
    'Valid for 30 days',
    'Unlimited rehearsals',
    'SEEK-hosted applications',
    'Application tracking included',
  ],
  'intensive-pass': [
    '250 successful applications',
    'Valid for 30 days',
    'Unlimited rehearsals',
    'Applications on supported external sites',
    'Application tracking included',
  ],
};

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
            <p>
              <strong>{status.rehearsals.unlimited ? 'Unlimited' : status.rehearsals.remaining}</strong>
              {status.rehearsals.unlimited ? ' rehearsals' : ` of ${status.rehearsals.allowance} rehearsals left`}
              <span>{status.rehearsals.unlimited ? 'Included with your active pass' : `Resets ${dateLabel(status.free.resetsAt)}`}</span>
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
        <span className="pricing-kicker">Simple one-time pricing</span>
        <h2>Pay only when your search needs more capacity</h2>
        <p>Every account includes monthly applications and rehearsals. Paid passes never auto-renew and include unlimited rehearsals.</p>
      </section>

      <div className="pricing-grid">
        <article className="pricing-card">
          <div>
            <span className="pricing-plan-label">Start here</span>
            <h3>Free</h3>
            <p className="pricing-plan-copy">Try the complete application workflow at your own pace.</p>
          </div>
          <p className="pricing-price"><strong>A$0</strong><span>forever</span></p>
          <ul className="pricing-features">
            <li>10 successful applications each month</li>
            <li>30 completed rehearsals each month</li>
            <li>SEEK-hosted applications</li>
            <li>Application tracking included</li>
            <li>No payment details required</li>
          </ul>
          <button className="btn pricing-cta" disabled>Your current base plan</button>
        </article>

        {(Object.keys(PASS_FEATURES) as Array<keyof typeof PASS_FEATURES>).map((key) => {
          const plan = PAID_PLANS[key];
          const recommended = key === 'job-search-pass';
          return (
            <article className={`pricing-card ${recommended ? 'recommended' : ''}`} key={key}>
              <div>
                <span className="pricing-plan-label">{recommended ? 'Best for most searches' : 'For an intensive search'}</span>
                <h3>{plan.name}</h3>
                <p className="pricing-plan-copy">{plan.description}</p>
              </div>
              <p className="pricing-price"><strong>{aud(plan.priceCents)}</strong><span>one time</span></p>
              <ul className="pricing-features">
                {PASS_FEATURES[key].map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
              <button
                className={`btn pricing-cta ${recommended ? 'primary' : ''}`}
                disabled={checkoutDisabled}
                onClick={() => void buy(key)}
              >
                {buying === key ? 'Opening checkout…' : `Choose ${plan.name}`}
              </button>
            </article>
          );
        })}
      </div>

      <section className="topup-card">
        <div>
          <span className="pricing-plan-label">Need a little more?</span>
          <h3>{PAID_PLANS['application-top-up'].name}</h3>
            <p>Add 50 successful applications, valid for 30 days. It is a one-time purchase.</p>
        </div>
        <div className="topup-action">
          <p className="pricing-price"><strong>{aud(PAID_PLANS['application-top-up'].priceCents)}</strong><span>one time</span></p>
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
        <h2>Clear and fair usage</h2>
        <div>
          <article>
            <strong>Only successful submissions count</strong>
            <p>Skipped jobs, failed forms, off-platform listings and items needing your attention do not use your allowance.</p>
          </article>
          <article>
            <strong>30 free rehearsals each month</strong>
            <p>The Free plan includes 30 completed rehearsals monthly. Active paid passes include unlimited rehearsals.</p>
          </article>
          <article>
            <strong>No surprise renewal</strong>
            <p>Passes and top-ups are one-time Stripe payments. Buy another only when you choose.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
