import {FREE_APPLICATIONS,type PassPlanKey} from '../pricing';
import {SEEK_CONNECTION_APPLICATIONS} from '../free-trial';
import {BoardBrand} from './BoardBrand';
import {EMPLOYER_SOURCES} from '../../../seek-bot/src/employer-source-config';
import {GUEST_EMPLOYER_SOURCES} from '../../../seek-bot/src/guest-applications';

export function PricingFreeOffer() {
 return <section className="pricing-free-start" aria-label="Free application offer">
  <div><span className="pricing-free-eyebrow">Start free</span><strong>{FREE_APPLICATIONS} free applications</strong><p>Apply on employer websites without creating an account. No job-board connection or card needed.</p></div>
  <div className="pricing-free-reward"><BoardBrand board="seek" compact/><strong>+{SEEK_CONNECTION_APPLICATIONS} free when you connect SEEK</strong><p>{FREE_APPLICATIONS+SEEK_CONNECTION_APPLICATIONS} free applications in total. Connecting is optional.</p></div>
 </section>;
}

export function PricingSources({plan}:{plan:'free'|PassPlanKey}) {
 const boards=plan==='free'?['seek']:['seek','indeed','jora',...(plan==='intensive-pass'?EMPLOYER_SOURCES.map(source=>source.id):GUEST_EMPLOYER_SOURCES)];
 return <div className="pricing-source-brands" role="group" aria-label="Supported job sources">
  {boards.map(board=><BoardBrand key={board} board={board} compact/>)}
  {plan==='free'&&<span className="pricing-source-note">Optional connection</span>}
 </div>;
}
