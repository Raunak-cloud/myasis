import type {FreeTrialOffer as Offer} from '../free-trial';
import {FREE_APPLICATIONS} from '../pricing';
import {OPEN_BOARD_SIGNIN} from '../boards';
import {BoardLogo} from './BoardBrand';

export function FreeTrialOffer({offer,running=false}:{offer?:Offer;running?:boolean}) {
 if(!offer)return null;
 return <div className="banner free-trial-offer" role="status">
  <div className="free-trial-offer-copy"><span className="free-trial-eyebrow">{offer.seekBonusAwarded?'Your SEEK bonus':'Your free start'}</span><strong>{offer.seekBonusAwarded?`${offer.seekBonusApplications} extra free applications unlocked`:`${FREE_APPLICATIONS} free applications`}</strong>
   {!offer.seekBonusAwarded&&<span className="free-trial-subtitle">No job-board connection needed.</span>}
   <p>{offer.seekBonusAwarded?'Use your free credits on direct employer forms without account creation, or on SEEK.':'Apply on employer websites without creating an account.'}</p>
  </div>
  {!offer.seekBonusAwarded&&<div className="free-trial-offer-action"><span className="free-trial-bonus">Get {offer.seekBonusApplications} more free applications</span><button type="button" className="btn primary" disabled={running} onClick={()=>window.dispatchEvent(new CustomEvent(OPEN_BOARD_SIGNIN,{detail:'seek'}))}><BoardLogo board="seek"/>Connect SEEK · +{offer.seekBonusApplications} free</button><span className="free-trial-optional">Optional. Connect whenever you like.</span></div>}
 </div>;
}
