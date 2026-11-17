import type {FreeTrialOffer as Offer} from '../free-trial';
import {FREE_APPLICATIONS} from '../pricing';
import {OPEN_BOARD_SIGNIN} from '../boards';

export function FreeTrialOffer({offer,running=false}:{offer?:Offer;running?:boolean}) {
 if(!offer)return null;
 return <div className="banner free-trial-offer" role="status">
  <div><strong>{offer.seekBonusAwarded?`${offer.seekBonusApplications} extra free applications unlocked`:`${FREE_APPLICATIONS} free applications. No job-board connection needed.`}</strong>
   <p className="job-meta">{offer.seekBonusAwarded?'Your free credits work on employer websites and SEEK.':`Start on employer websites, or connect SEEK whenever you like to get ${offer.seekBonusApplications} more free applications.`}</p>
  </div>
  {!offer.seekBonusAwarded&&<button type="button" className="btn" disabled={running} onClick={()=>window.dispatchEvent(new CustomEvent(OPEN_BOARD_SIGNIN,{detail:'seek'}))}>Connect SEEK · +{offer.seekBonusApplications} free</button>}
 </div>;
}
