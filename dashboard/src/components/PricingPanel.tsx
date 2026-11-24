import {dashboardGet} from '../dashboard-requests.js';
import { useCallback, useEffect, useState } from 'react';
import { aud, PAID_PLANS, PLAN_PRESENTATION, planFeatureHelp, type PaidPlanKey, type PassPlanKey } from '../pricing';
import { BILLING_CHANGED, type BillingStatus } from '../billing';
import { trackRedditEvent } from '../redditPixel';
import { trackMetaEvent } from '../metaPixel';
import './PricingPanel.css';
import {PricingSources} from './PricingSources';
import { InfoTip } from './FieldLabel';


function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric' })
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
    const response = await dashboardGet('/api/billing/status');
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
          if (body.refunded) {
            setNotice({ kind: 'warn', text: 'Your plan changed before payment completed. This payment was refunded.' });
            return;
          }
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
              value: (body.amountPaidCents ?? product.priceCents) / 100,
              currency: 'AUD',
              itemCount: 1,
            });
            trackMetaEvent('Purchase', {
              value: (body.amountPaidCents ?? product.priceCents) / 100,
              currency: 'AUD',
            }, body.conversionId);
          }
          setNotice({ kind: 'ok', text: body.kind === 'upgrade' && product && body.expiresAt
            ? `Upgraded to ${product.name}. Access ends ${dateLabel(body.expiresAt)}.`
            : body.planKey === 'intensive-pass' ? `Get Owtomated is active: unlimited applications for ${body.durationDays ?? PAID_PLANS['intensive-pass'].durationDays} days.` : `${body.applications} applications were added to your account.` });
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

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void loadStatus().catch(() => {}); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const end = status?.paid.expiresAt ? Date.parse(status.paid.expiresAt) - Date.now() : null;
    const timer = end !== null && end > 0 ? window.setTimeout(refresh, Math.min(end + 1000, 2_147_483_647)) : undefined;
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); window.clearTimeout(timer); };
  }, [loadStatus, status?.paid.expiresAt]);

  const buy = async (planKey: PaidPlanKey) => {
    const offer = status?.offers?.[planKey];
    if (offer?.kind === 'blocked') return;
    setBuying(planKey);
    setNotice(null);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey, quotedAt: offer?.quotedAt, sourceGrantId: offer?.sourceGrantId,
          amountCents: offer?.amountCents, expiresAt: offer?.expiresAt }),
      });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.error || 'Could not open checkout.');
      window.location.assign(body.url);
    } catch (error) {
      setNotice({ kind: 'bad', text: (error as Error).message });
      setBuying(null);
      void loadStatus().catch(() => {});
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

      {status && (
        <section className="pricing-status" aria-label="Your plan and allowance">
          <div className="pricing-status-plan">
            <span className="pricing-status-label">Your plan</span>
            <strong>{PLAN_CARDS.find((card) => card.key === current)?.name}</strong>
          </div>
          <div className="pricing-status-stat">
            <span>Applications available</span>
            <strong>{status.paid.unlimitedApplications ? 'Unlimited' : status.totalRemaining}</strong>
          </div>
          <div className="pricing-status-stat">
            <span>{status.paid.hasActivePass ? 'Access ends' : 'Free allowance'}</span>
            <strong>{status.paid.expiresAt ? dateLabel(status.paid.expiresAt) : 'No expiry'}</strong>
          </div>
        </section>
      )}

      <div className="pricing-grid">
        {PLAN_CARDS.map((card) => {
          const isCurrent = card.key === current;
          const paidPlan = card.key !== 'free' ? card.key : undefined;
          const offer = paidPlan ? status?.offers?.[paidPlan] : undefined;
          const upgrade = offer?.kind === 'upgrade' && offer.expiresAt ? offer : undefined;
          const lowerPlan = paidPlan !== undefined && PLAN_CARDS.findIndex(plan => plan.key === paidPlan) < PLAN_CARDS.findIndex(plan => plan.key === current);
          const unavailable = isCurrent || lowerPlan || offer?.kind === 'blocked';
          const label = buying === card.key
            ? 'Opening checkout…'
            : isCurrent
              ? 'Your pass is active'
              : lowerPlan
                ? 'Lower plan unavailable'
              : offer?.kind === 'blocked'
                ? 'Unavailable'
              : upgrade
                ? `Upgrade to ${card.name}`
                : `Choose ${card.name}`;
          const features = card.presentation.features.map(feature => {
            if (!upgrade) return feature;
            if (feature === `${PAID_PLANS[card.key as PassPlanKey].durationDays} days of access`) return `Access until ${dateLabel(upgrade.expiresAt!)}`;
            if (upgrade.additionalEmployerSiteApplications && /^\d+ employer-site applications/.test(feature)) {
              const count = upgrade.additionalEmployerSiteApplications;
              return `${count} extra employer-site ${count === 1 ? 'application' : 'applications'} (guest forms only)`;
            }
            if (card.key !== 'intensive-pass' && /application credits$/.test(feature)) return `${upgrade.additionalApplications} additional application credits`;
            return feature;
          });
          // Access dates sit beside the price; source names sit in the logo row.
          const details = features.filter(feature =>
            !/^\d+ days of access$|^Access until |^SEEK.* applications$|^Greenhouse and Workday job sources$|^Personalised cover letters/.test(feature)
            && !/^Jobs that match your resume by at least |^Choose your minimum match score:/.test(feature));
          const featureItem = (feature: string, beta = false) => {
            const label = feature.replace(/ · Auto apply or Semi auto$/, '').replace(/^Up to /, '')
                .replace(/ scheduled (runs?) each day$/, ' scheduled $1/day')
                .replace(/^AI reviews up to (\d+) jobs each run$/, 'Reviews up to $1 jobs/run')
                .replace(/^Connect SEEK for (\d+) extra free applications \((\d+) total\)$/, '$1 extra with SEEK ($2 total)')
                .replace('Only employer forms that do not require an account', 'Forms without an account')
                .replace('Advanced match and listing-age filters', 'Match & listing-age filters')
                .replace('Supported employer-site applications', 'Employer-site applications');
            const help = planFeatureHelp(feature);
            const lastWordStart = label.lastIndexOf(' ') + 1;
            return (
              <li key={feature}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                <span>
                  {label.slice(0, lastWordStart)}
                  <span className="pricing-feature-end">
                    {label.slice(lastWordStart)}{beta && <> <span className="beta-flag">Beta</span></>}
                    {help && <> <InfoTip label={beta ? `${label} (beta)` : label} icon="?" help={help} /></>}
                  </span>
                </span>
              </li>
            );
          };
          return (
            <article className={`pricing-card ${card.key === 'intensive-pass' ? 'premium' : ''} ${card.recommended ? 'recommended' : ''} ${isCurrent ? 'current' : ''}`} key={card.key}>
              <div className="pricing-plan-summary">
                <div className="pricing-card-top">
                  <h3>{card.name}</h3>
                  {isCurrent ? (
                    <span className="pricing-tag current">Current plan</span>
                  ) : card.recommended ? (
                    <span className="pricing-tag">Most popular</span>
                  ) : null}
                </div>
                <p className="pricing-price">
                  <strong>{upgrade ? aud(upgrade.amountCents!) : card.price}</strong>
                  <span>{upgrade ? `upgrade · ends ${dateLabel(upgrade.expiresAt!)}` : card.term}</span>
                </p>
              </div>
              <div className="pricing-plan-sources">
                <span className="pricing-section-label">Job sources</span>
                <PricingSources plan={card.key}/>
              </div>
              <section className="pricing-plan-details" aria-label={`${card.name} plan details`}>
                <h4>Plan details</h4>
                <ul className="pricing-features">
                  {details.map(feature => featureItem(feature))}
                  {card.key === 'intensive-pass' && featureItem('Email employers', true)}
                </ul>
              </section>
              {paidPlan && (
                <button
                  className={`btn pricing-cta ${card.recommended && !isCurrent ? 'primary' : ''}`}
                  disabled={checkoutDisabled || unavailable}
                  title={offer?.reason}
                  onClick={() => void buy(paidPlan)}
                >
                  {label}
                </button>
              )}
            </article>
          );
        })}
      </div>


    </div>
  );
}
