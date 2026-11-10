export const BONUS_RUN_MESSAGE='This bonus run won’t use any of your application credits or regular runs.';
export interface BonusRunOptions {
 maxApplications:number;
 applicationMode:'auto'|'semi-auto';
 message:string;
 salaryDiscountPercent:number;
}
export interface BonusRun extends BonusRunOptions {
 id:string;
 status:'queued'|'starting'|'running'|'completed'|'stopped'|'error';
 createdAt:string;
 startedAt:string|null;
 finishedAt:string|null;
 runId:string|null;
 applied:number;
 prepared:number;
}
