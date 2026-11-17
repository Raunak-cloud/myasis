import type {FreeTrialOffer as Offer} from '../free-trial';
import {FREE_APPLICATIONS} from '../pricing';
import {OPEN_BOARD_SIGNIN} from '../boards';
import {BoardLogo} from './BoardBrand';

export function FreeTrialOffer({offer,running=false}:{offer?:Offer;running?:boolean}) {
 if(!offer)return null;
 return <div className="card free-trial-offer" role="status">
  <strong>{offer.seekBonusAwarded?`${offer.seekBonusApplications} extra free applications unlocked`:`${FREE_APPLICATIONS} free applications`}</strong>
  {!offer.seekBonusAwarded&&<button type="button" className="btn free-trial-connect" aria-label={`Connect SEEK for ${offer.seekBonusApplications} extra free applications`} disabled={running} onClick={()=>window.dispatchEvent(new CustomEvent(OPEN_BOARD_SIGNIN,{detail:'seek'}))}><span>Connect</span><BoardLogo board="seek"/><span className="free-trial-bonus">+{offer.seekBonusApplications} free</span></button>}
 </div>;
}
