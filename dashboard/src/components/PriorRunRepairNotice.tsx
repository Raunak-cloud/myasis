import {priorRunRepairMessage} from '../priorRunRepair';
export function PriorRunRepairNotice({count,active=true}:{count:number;active?:boolean}){
 if(!Number.isInteger(count)||count<1)return null;
 return <div className="banner" role="status" aria-label="Owtobot prior-run recovery">
  <strong>{active?priorRunRepairMessage(count):'Owtobot finished this recovery run.'}</strong>
  <p className="job-meta">{active?`Retrying ${count} previously approved ${count===1?'application':'applications'}.`:'Check the results below for confirmed submissions and any remaining blockers.'}</p>
 </div>;
}
