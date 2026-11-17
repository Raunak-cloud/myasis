import type {FreeTrialOffer as Offer} from '../free-trial';
import {FREE_APPLICATIONS} from '../pricing';
import {OPEN_BOARD_SIGNIN} from '../boards';

export function FreeTrialOffer({offer,running=false}:{offer?:Offer;running?:boolean}) {
 if(!offer)return null;
 return <div className="banner free-trial-offer" role="status">
  <div><strong>{offer.seekBonusAwarded?`${offer.seekBonusApplications} extra free applications unlocked`:`${FREE_APPLICATIONS} free applications. No job-board connection needed.`}</strong>
   <p className="job-meta">{offer.seekBonusAwarded?'Use your free credits on direct employer forms without account creation, or on SEEK.':`Apply on employer websites without creating an account. Connect SEEK whenever you like to get ${offer.seekBonusApplications} more free applications.`}</p>
  </div>
  {!offer.seekBonusAwarded&&<button type="button" className="btn" disabled={running} onClick={()=>window.dispatchEvent(new CustomEvent(OPEN_BOARD_SIGNIN,{detail:'seek'}))}>Connect SEEK · +{offer.seekBonusApplications} free</button>}
 </div>;
}
