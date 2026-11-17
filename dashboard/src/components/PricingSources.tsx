import {FREE_APPLICATIONS,type PassPlanKey} from '../pricing';
import {SEEK_CONNECTION_APPLICATIONS} from '../free-trial';
import {BoardBrand} from './BoardBrand';

export function PricingFreeOffer() {
 return <section className="pricing-free-start" aria-label="Free application offer">
  <div><span className="pricing-free-eyebrow">Start free</span><strong>{FREE_APPLICATIONS} free applications</strong><p>Apply on employer websites without creating an account. No job-board connection or card needed.</p></div>
  <div className="pricing-free-reward"><BoardBrand board="seek" compact/><strong>+{SEEK_CONNECTION_APPLICATIONS} free when you connect SEEK</strong><p>{FREE_APPLICATIONS+SEEK_CONNECTION_APPLICATIONS} free applications in total. Connecting is optional.</p></div>
 </section>;
}

export function PricingSources({plan}:{plan:'free'|PassPlanKey}) {
 const boards=plan==='free'?['seek']:plan==='essential-pass'?['seek','jora']:['seek','indeed','jora'];
 return <div className="pricing-source-brands" aria-label="Job-board connections">
  {boards.map(board=><BoardBrand key={board} board={board} compact/>)}
  {plan==='free'&&<span className="pricing-source-note">Optional SEEK connection</span>}
 </div>;
}
