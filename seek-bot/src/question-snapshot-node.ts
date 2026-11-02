import { createHash } from 'node:crypto';
import { isQuestionSnapshot, questionIdentity, questionRevision, type QuestionSnapshot } from './question-snapshot.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export function sealQuestionSnapshot(s: Omit<QuestionSnapshot,'id'|'revision'>): QuestionSnapshot {
  return {...s,id:`q2_${digest(questionIdentity(s))}`,revision:digest(questionRevision(s))};
}
export function verifiedQuestionSnapshot(raw: unknown): raw is QuestionSnapshot {
  return isQuestionSnapshot(raw) && raw.id === sealQuestionSnapshot(raw).id && raw.revision === sealQuestionSnapshot(raw).revision;
}
