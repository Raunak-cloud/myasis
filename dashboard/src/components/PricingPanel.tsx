import { useCallback, useEffect, useState } from 'react';
import { aud, HUMANIZER_NOTE, PAID_PLANS, PLAN_PRESENTATION, type PaidPlanKey, type PassPlanKey } from '../pricing';
import { BILLING_CHANGED, type BillingStatus } from '../billing';
import { trackRedditEvent } from '../redditPixel';
import { MascotLogo } from './MascotLogo';


function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(value));
}

type PlanCardKey = 'free' | PassPlanKey;

/** The four plans as the page presents them, in the order they are compared. */
const PLAN_CARDS: Array<{
  key: PlanCardKey;
  name: string;
  price: string;
  term: string;
  recommended: boolean;
  presentation: { label: string; description: string; features: readonly string[] };
}> = [
  { key: 'free', name: 'Free', price: aud(0), term: 'no card needed', recommended: false, presentation: PLAN_PRESENTATION.free },
  {
    key: 'essential-pass', name: PAID_PLANS['essential-pass'].name, price: aud(PAID_PLANS['essential-pass'].priceCents),
    term: `one payment · ${PAID_PLANS['essential-pass'].durationDays} days`, recommended: false, presentation: PLAN_PRESENTATION['essential-pass'],
  },
  {
    key: 'job-search-pass', name: PAID_PLANS['job-search-pass'].name, price: aud(PAID_PLANS['job-search-pass'].priceCents),
    term: `one payment · ${PAID_PLANS['job-search-pass'].durationDays} days`, recommended: true, presentation: PLAN_PRESENTATION['job-search-pass'],
  },
  {
    key: 'intensive-pass', name: PAID_PLANS['intensive-pass'].name, price: aud(PAID_PLANS['intensive-pass'].priceCents),
    term: `one payment · ${PAID_PLANS['intensive-pass'].durationDays} days`, recommended: false, presentation: PLAN_PRESENTATION['intensive-pass'],
  },
];

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
          window.dispatchEvent(new Event(BILLING_CHANGED));
          const product = PAID_PLANS[body.planKey as PaidPlanKey];
          /**
           * The server reported this purchase as it banked it and handed back
           * the id it used. Echoing the same id lets Reddit drop one of the
           * pair. Absent when the webhook got here first, and then the server's
           * report is the only one — which is the point of having both.
           */
          if (body.conversionId && product) {
            trackRedditEvent('Purchase', {
              conversionId: body.conversionId,
              value: product.priceCents / 100,
              currency: 'AUD',
              itemCount: 1,
            });
          }
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

  /** The highest pass held; an account can hold both, and the page marks the one that governs its runs. */
  const current: PlanCardKey = status?.paid.hasActiveIntensivePass
    ? 'intensive-pass'
    : status?.paid.hasActiveJobSearchPass
      ? 'job-search-pass'
      : status?.paid.hasActiveEssentialPass
        ? 'essential-pass'
        : 'free';

  return (
    <div className="pricing-page">
      {notice && <div className={`pricing-notice ${notice.kind}`} role="status">{notice.text}</div>}
      {!loading && status && !status.configured && (
        <div className="pricing-notice warn">Checkout is not available right now. Your free applications still work.</div>
      )}

      <header className="pricing-head">
        <span className="pricing-kicker">Plans &amp; pricing</span>
        <h2>Choose how actively you want to search</h2>
        <p>Every pass is one payment with no automatic renewal. Higher plans add more applications, more daily runs, more job boards and more control. Only submitted applications count.</p>
      </header>

      {status && (
        <section className="pricing-status" aria-label="Your plan and allowance">
          <div className="pricing-status-plan">
            <span className="pricing-status-label">Your plan</span>
            <strong>{PLAN_CARDS.find((card) => card.key === current)?.name}</strong>
          </div>
          <div className="pricing-status-stat">
            <strong>{status.totalRemaining}</strong>
            <span>applications available now</span>
          </div>
          <div className="pricing-status-stat">
            <strong>{status.free.remaining}<em> / {status.free.allowance}</em></strong>
            <span>free applications</span>
          </div>
          <div className="pricing-status-stat">
            <strong>{status.paid.remaining}</strong>
            <span>
              {!status.paid.hasActivePass
                ? 'no active paid pass'
                : status.paid.expiresAt
                  ? `on your pass · until ${dateLabel(status.paid.expiresAt)}`
                  : 'on a grandfathered pass · no expiry'}
            </span>
          </div>
        </section>
      )}

      <div className="pricing-grid">
        {PLAN_CARDS.map((card) => {
          const isCurrent = card.key === current;
          const paid = card.key !== 'free';
          const label = !paid
            ? 'Included with every account'
            : buying === card.key
              ? 'Opening checkout…'
              : isCurrent
                ? 'Buy this pass again'
                : `Choose ${card.name}`;
          return (
            <article className={`pricing-card ${card.recommended ? 'recommended' : ''} ${isCurrent ? 'current' : ''}`} key={card.key}>
              <div className="pricing-card-top">
                <span className="pricing-plan-label">{card.presentation.label}</span>
                {isCurrent ? (
                  <span className="pricing-tag current">Current plan</span>
                ) : card.recommended ? (
                  <span className="pricing-tag">Most popular</span>
                ) : null}
              </div>
              {/* The owl at work, on the plans where Owtomate does the work. The same drawing as the landing page. */}
              {paid && (
                <span className="pricing-owl" aria-hidden="true">
                  <MascotLogo size={40} className="pricing-owl-face" />
                  <svg className="pricing-owl-laptop" viewBox="0 0 56 22" width="56" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M9 2h38v13H9z" fill="#fff" />
                    <path d="M3 15h50l-3 5H6z" fill="#fff" />
                  </svg>
                </span>
              )}
              <h3>{card.name}</h3>
              <p className="pricing-plan-copy">{card.presentation.description}</p>
              <p className="pricing-price">
                <strong>{card.price}</strong>
                <span>{card.term}</span>
              </p>
              <ul className="pricing-features">
                {card.presentation.features.map((feature) => (
                  <li key={feature}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                className={`btn pricing-cta ${card.recommended && !isCurrent ? 'primary' : ''}`}
                disabled={!paid || checkoutDisabled}
                onClick={() => card.key !== 'free' && void buy(card.key)}
              >
                {label}
              </button>
            </article>
          );
        })}
      </div>

      <ul className="pricing-trust" aria-label="Payment terms">
        <li>Secure checkout by Stripe</li>
        <li>One payment, no renewal</li>
        <li>Prices in Australian dollars</li>
        <li>Clear pass end date before payment</li>
      </ul>

      {/* A top-up adds to a pass, so on the free plan it is shown but not for sale; the server refuses it too. */}
      <section className={`pricing-topup ${current === 'free' ? 'unavailable' : ''}`}>
        <div className="pricing-topup-copy">
          <span className="pricing-plan-label">Top-up · for pass holders</span>
          <h3>{PAID_PLANS['application-top-up'].applications} more applications</h3>
          <p>
            {current === 'free'
              ? 'Adds applications to an active paid pass. Choose a pass first.'
              : 'Adds to your balance without changing your tier. The top-up ends with your active pass.'}
          </p>
        </div>
        <div className="pricing-topup-action">
          <p className="pricing-price">
            <strong>{aud(PAID_PLANS['application-top-up'].priceCents)}</strong>
            <span>one payment</span>
          </p>
          <button
            className="btn pricing-cta"
            disabled={checkoutDisabled || current === 'free'}
            title={current === 'free' ? 'Available with an active paid pass.' : undefined}
            onClick={() => void buy('application-top-up')}
          >
            {buying === 'application-top-up' ? 'Opening checkout…' : current === 'free' ? 'Needs a pass' : `Add ${PAID_PLANS['application-top-up'].applications} applications`}
          </button>
        </div>
      </section>

      <section className="pricing-explainer" aria-label="How usage works">
        <article>
          <strong>Only submitted applications count</strong>
          <p>Skipped jobs, failed forms and anything that needs your attention do not use your allowance.</p>
        </article>
        <article>
          <strong>No surprise renewal</strong>
          <p>Your pass has a clear end date and never renews or charges again on its own.</p>
        </article>
        <article>
          <strong>Higher plans do more</strong>
          <p>Upgrade for Indeed, Humanizer, more daily runs, advanced controls and employer-site applications.</p>
        </article>
      </section>

      <p className="job-meta pricing-footnote">{HUMANIZER_NOTE}</p>
    </div>
  );
}
