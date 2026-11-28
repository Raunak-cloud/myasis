import type {BonusRunOptions} from '../src/bonus-run.js';
import type {BillingStatus} from './billing.js';
import {BONUS_DISCOVERY_LIMITS} from '../../seek-bot/src/run-limits.js';

export interface BonusDiscoveryPlan {
 titles: string[];
 maxReviews: number;
 timeoutMinutes: number;
}

/** Internal operator grant. The public bonus request still uses bonusRunOptions. */
export function bonusDiscoveryPlan(raw: unknown): BonusDiscoveryPlan | null {
 if(raw===null||raw===undefined)return null;
 if(typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid bonus discovery grant.');
 const {titles,maxReviews,timeoutMinutes}=raw as Partial<BonusDiscoveryPlan>;
 if(!Array.isArray(titles)||!titles.length||titles.length>BONUS_DISCOVERY_LIMITS.titles
  ||titles.some(title=>typeof title!=='string'||!title.trim()||title.length>100||/[,\r\n\x00]/.test(title))
  ||!Number.isSafeInteger(maxReviews)||maxReviews!<1||maxReviews!>BONUS_DISCOVERY_LIMITS.reviews
  ||!Number.isSafeInteger(timeoutMinutes)||timeoutMinutes!<1||timeoutMinutes!>BONUS_DISCOVERY_LIMITS.minutes)
  throw Error('Invalid bonus discovery grant.');
 const clean=titles.map(title=>title.trim());
 if(new Set(clean.map(title=>title.toLowerCase())).size!==clean.length)throw Error('Bonus discovery titles must be unique.');
 return {titles:clean,maxReviews:maxReviews!,timeoutMinutes:timeoutMinutes!};
}

export function bonusRunOptions(raw:unknown):BonusRunOptions {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Choose the bonus run settings.');
 const value=raw as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['maxApplications','applicationMode','message','salaryDiscountPercent','includeJora'].includes(key)))throw Error('Unsupported bonus run setting.');
 if(value.includeJora!==undefined&&typeof value.includeJora!=='boolean')throw Error('Choose whether to include Jora for this bonus run.');
 if(!Number.isInteger(value.maxApplications)||Number(value.maxApplications)<1||Number(value.maxApplications)>50)throw Error('Choose between 1 and 50 applications.');
 if(!['auto','semi-auto'].includes(String(value.applicationMode)))throw Error('Choose Auto apply or Semi auto.');
 if(value.message!==undefined&&(typeof value.message!=='string'||value.message.length>240))throw Error('Use a customer message of up to 240 characters.');
 const discount=value.salaryDiscountPercent??0;
 if(typeof discount!=='number'||!Number.isFinite(discount)||discount<0||discount>10)throw Error('A one-run salary reduction must be between 0% and 10%.');
 return {maxApplications:Number(value.maxApplications),applicationMode:value.applicationMode as BonusRunOptions['applicationMode'],message:String(value.message??'').trim(),salaryDiscountPercent:discount,...(value.includeJora!==undefined?{includeJora:value.includeJora as boolean}:{})};
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
