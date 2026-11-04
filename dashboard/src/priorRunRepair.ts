export interface PriorRunRepair { count:number; sourceRunIds:string[] }
export function priorRunRepairMessage(count:number):string {
 return count===1?'Owtobot found an issue in a prior run and is fixing it.':'Owtobot found a few issues in your prior runs and is fixing them.';
}
