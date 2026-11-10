import type {BonusRunOptions} from '../src/bonus-run.js';
import type {BillingStatus} from './billing.js';

export function bonusRunOptions(raw:unknown):BonusRunOptions {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose the bonus run settings.');
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['maxApplications','applicationMode','message','salaryDiscountPercent'].includes(key)))throw Error('Unsupported bonus run setting.');
 if(!Number.isInteger(value.maxApplications)||Number(value.maxApplications)<1||Number(value.maxApplications)>50)throw Error('Choose between 1 and 50 applications.');
 if(!['auto','semi-auto'].includes(String(value.applicationMode)))throw Error('Choose Auto apply or Semi auto.');
 if(value.message!==undefined&&(typeof value.message!=='string'||value.message.length>240))throw Error('Use a customer message of up to 240 characters.');
 const discount=value.salaryDiscountPercent??0;
 if(typeof discount!=='number'||!Number.isFinite(discount)||discount<0||discount>10)throw Error('A one-run salary reduction must be between 0% and 10%.');
 return {maxApplications:Number(value.maxApplications),applicationMode:value.applicationMode as BonusRunOptions['applicationMode'],message:String(value.message??'').trim(),salaryDiscountPercent:discount};
}

/** A run-local projection only. No credit grant, pass, plan or preference changes. */
export function bonusRunAllowance(current:BillingStatus,maxApplications:number):BillingStatus {
 return {...current,totalRemaining:maxApplications,paid:{...current.paid,remaining:maxApplications,
  employerSiteRemaining:maxApplications,unlimitedApplications:true}};
}

export function bonusSalaryFloor(saved:string,discountPercent:number):string {
 const amount=Number(saved);
 if(!Number.isFinite(amount)||amount<0)throw Error('The saved minimum salary is not available.');
 return String(Math.ceil(amount*(1-discountPercent/100)));
}
