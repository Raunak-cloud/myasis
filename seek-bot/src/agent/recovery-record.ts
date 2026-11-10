import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ToolContext } from './context.js';
import type { AgentFiles } from './agent-files.js';

export interface RecoveryScope { runId: string; jobId: string; platform: string; mode: string; contextHash: string }
export interface RecoveryWork {
  captured: ToolContext['captured']; actions: ToolContext['actions']; coverLetter?: string;
  documents?: ToolContext['documents']; uploads?: ReturnType<AgentFiles['checkpointUploads']>;
  letterWitness?: ReturnType<AgentFiles['checkpointLetterWitness']>;
  resumeUsed?: string; resumeName?: string; files: ReturnType<AgentFiles['checkpoint']>;
  pendingCredentials?: Array<[string, NonNullable<ToolContext['pendingCredentials']> extends Map<string, infer T> ? T : never]>;
  authenticationRealm?: string;
}
interface Operation { id: string; tool: string; action?: string; mutating: boolean; startedAt: string }
interface Evidence { tool: string; action?: string; result: string; disposition: string; at: string }
export type UncertaintyKind = 'authentication' | 'submission' | 'operation' | 'form';
interface InvestigationCheck { id: string; key: string; question: string; check: string; status: 'pending' | 'complete'; result?: string; at: string }
interface Investigation { id: string; key: string; kind: UncertaintyKind; question: string; status: 'investigating' | 'resolved' | 'unresolved';
  checks: InvestigationCheck[]; outcome?: string; evidence?: string }
interface RecordState {
  schema: 1; id: string; scope: RecoveryScope; revision: number; evidenceVersion: number;
  status: 'active' | 'paused' | 'interrupted' | 'finished'; work?: RecoveryWork;
  controls?: Record<string, unknown>; observation?: unknown; pending?: Operation;
  evidence: Evidence[]; submissionAttempted: boolean;
  investigations?: Investigation[];
}
export class RecoveryRecordError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
function addUncertainty(state: RecordState,kind: UncertaintyKind,key: string,question: string): void {
  if(state.investigations?.some(item=>item.kind===kind&&item.key===key&&item.status==='investigating'))return;
  (state.investigations??=[]).push({id:randomUUID(),key,kind,question,status:'investigating',checks:[]});
}

/** Owner-local durable state, not an instruction log to replay. A live writer
 * never loses its lease on a timer. SQLite serializes cross-process claims;
 * revision checks reject stale updates, including old tool results. */
export class RecoveryRecord {
  readonly id: string;
  private readonly db: DatabaseSync;
  private readonly token = randomUUID();
  private closed = false;
  constructor(directory: string, private readonly worker: string, scope: RecoveryScope,
    id: string = randomUUID(), private readonly redact: (value: unknown) => unknown = value => value, resume = false) {
    this.id = id;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = resolve(directory, 'application-recovery.sqlite');
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS recovery_records(id TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS recovery_evidence(record_id TEXT NOT NULL, revision INTEGER NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY(record_id,revision));
        CREATE TABLE IF NOT EXISTS recovery_writers(worker TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, record_id TEXT NOT NULL);`);
      let uncertainResume=false;
      this.transaction(() => {
        const writers = this.db.prepare('SELECT token,pid FROM recovery_writers WHERE worker=? OR record_id=?').all(worker,id);
        if (writers.some(writer=>alive(Number(writer.pid)))) throw new RecoveryRecordError('This application browser already has an active writer. No browser operation was started.');
        const row = this.db.prepare('SELECT state FROM recovery_records WHERE id=?').get(id);
        if (resume && !row) throw new RecoveryRecordError('This owner has no matching recovery record. No historical work was adopted.');
        if (row) {
          const saved = JSON.parse(String(row.state)) as RecordState;
          if (saved.schema !== 1 || hash(saved.scope) !== hash(scope) || saved.status === 'finished') throw new RecoveryRecordError('Recovery record does not match the current run, job, mode, candidate or approval.');
          if (saved.pending?.mutating || saved.submissionAttempted) {
            addUncertainty(saved,saved.submissionAttempted?'submission':'operation','interrupted-operation','The prior operation was interrupted before its outcome could be established. Investigate actual employer state and this job\'s send history; do not replay the operation.');
            saved.status='interrupted';saved.revision++;
            this.db.prepare('UPDATE recovery_records SET state=? WHERE id=?').run(JSON.stringify(saved),id);
            uncertainResume=true;return;
          }
          // Legacy consultation metadata is ignored by the applying agent.
          delete (saved as unknown as Record<string, unknown>).consultation;
          delete saved.pending; // Only interrupted read-only work reaches here.
          saved.revision++; saved.status = 'active';
          this.db.prepare('UPDATE recovery_records SET state=? WHERE id=?').run(JSON.stringify(saved), id);
        } else {
          const state: RecordState = { schema: 1, id, scope, revision: 0, evidenceVersion: 0, status: 'active', evidence: [], submissionAttempted: false };
          this.db.prepare('INSERT INTO recovery_records VALUES(?,?)').run(id, JSON.stringify(state));
        }
        this.db.prepare('DELETE FROM recovery_writers WHERE worker=? OR record_id=?').run(worker,id);
        this.db.prepare('INSERT INTO recovery_writers VALUES(?,?,?,?)').run(worker, this.token, process.pid, id);
      });
      if(uncertainResume)throw new RecoveryRecordError('An earlier operation or send has an uncertain outcome. Investigation evidence was preserved. Reconcile actual employer state and duplicate checks before any continuation. Nothing was replayed.');
    } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertWriter(): void {
    if (this.closed || this.db.prepare('SELECT token FROM recovery_writers WHERE worker=? AND record_id=?').get(this.worker, this.id)?.token !== this.token)
      throw new RecoveryRecordError('The browser writer no longer owns this recovery record. No further operation is permitted.');
  }
  snapshot(): Readonly<RecordState> {
    this.assertWriter();
    return JSON.parse(String(this.db.prepare('SELECT state FROM recovery_records WHERE id=?').get(this.id)!.state));
  }
  private update(work: (state: RecordState) => void): void {
    this.transaction(() => {
      this.assertWriter(); const state = this.snapshot() as RecordState, revision = state.revision;
      work(state); state.revision++;
      // The transaction owns the write lock; checking revision also makes the
      // optimistic contract explicit for callers holding old snapshots.
      const result = this.db.prepare("UPDATE recovery_records SET state=? WHERE id=? AND json_extract(state,'$.revision')=?")
        .run(JSON.stringify(state), this.id, revision);
      if (result.changes !== 1) throw new RecoveryRecordError('A stale recovery update was rejected.');
    });
  }
  private clean<T>(value: T, stripLinks = true): T {
    const privateKeys = /^(?:password|passphrase|otp|token|authorization|cookie|secret|screenshot)$/i;
    const visit = (item: any): any => {
      if (typeof item === 'string') return stripLinks ? item.replace(/https?:\/\/[^\s"<>]+/g, text => {
        try { const url = new URL(text); return url.origin + url.pathname.split('/').map(part => part.length > 24 ? '[private]' : part).join('/'); } catch { return '[site URL]'; }
      }) : item;
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object') {
        const privateField = item.sensitive || item.privateKind || item.inputType === 'password';
        return Object.fromEntries(Object.entries(item).filter(([key]) => !privateKeys.test(key))
          .map(([key, entry]) => [key, privateField && key === 'currentValue' ? '[credential withheld]' : visit(entry)]));
      }
      return item;
    };
    return visit(this.redact(value));
  }
  checkpoint(work: RecoveryWork, controls: Record<string, unknown>, observation?: unknown, submissionAttempted = false): void {
    this.update(state => {
      // Candidate-authored documents/answers must remain byte-for-byte intact.
      // Only browser evidence has potentially private activation/reset URLs.
      const evidence = { work: this.clean(work, false), observation: this.clean(observation) };
      if (hash([state.work, state.observation]) !== hash([evidence.work, evidence.observation])) state.evidenceVersion++;
      state.work = evidence.work; state.controls = this.clean(controls);
      if (observation !== undefined) state.observation = evidence.observation;
      state.submissionAttempted ||= submissionAttempted;
    });
  }
  begin(tool: string, action: string | undefined, mutating: boolean): string {
    const id = randomUUID();
    this.update(state => {
      if (state.pending) throw new RecoveryRecordError('An operation is still pending; a second browser plan cannot overtake it.');
      state.pending = { id, tool, action, mutating, startedAt: new Date().toISOString() };
    });
    return id;
  }
  complete(id: string, result: string, disposition: string, work: RecoveryWork, submissionAttempted: boolean, controls?: Record<string,unknown>): void {
    this.update(state => {
      if (state.pending?.id !== id) throw new RecoveryRecordError('A stale operation result cannot overwrite current recovery state.');
      const adviceOnly = state.pending.tool === 'consult_application_specialist';
      if (!adviceOnly) {
        const evidence = { tool: state.pending.tool, action: state.pending.action, result: String(this.clean(result)), disposition, at: new Date().toISOString() };
        // Keep the complete evidence journal in this same transaction. The
        // prompt window is bounded; eviction from it must not erase old proof.
        this.db.prepare('INSERT INTO recovery_evidence VALUES(?,?,?)').run(this.id,state.revision+1,JSON.stringify(evidence));
        state.evidence.push(evidence);
      }
      state.evidence = state.evidence.slice(-16); delete state.pending;
      state.work = this.clean(work, false);
      if(submissionAttempted&&!state.submissionAttempted)addUncertainty(state,'submission','possible-send','A send was attempted; delivery is unknown until actual employer receipt is established. Inspect the current page and owner-scoped history. Never click Send again to investigate.');
      state.submissionAttempted ||= submissionAttempted;
      if(controls) state.controls=this.clean(controls);
      if (!adviceOnly) state.evidenceVersion++;
    });
  }
  /** Helper primitives use the parent's live executor and lease. Retain each
   * actual result without clearing the enclosing operation's crash guard. */
  recordHelperResult(tool:string,action:string|undefined,result:string,disposition:string,work:RecoveryWork,controls:Record<string,unknown>):void {
    this.update(state=>{
      if(!state.pending?.tool.startsWith('helper_')||!state.pending.mutating)throw new RecoveryRecordError('A helper result requires its active parent operation.');
      const evidence={tool,action,result:String(this.clean(result)),disposition,at:new Date().toISOString()};
      this.db.prepare('INSERT INTO recovery_evidence VALUES(?,?,?)').run(this.id,state.revision+1,JSON.stringify(evidence));
      state.evidence.push(evidence);state.evidence=state.evidence.slice(-16);
      state.work=this.clean(work,false);state.controls=this.clean(controls);state.evidenceVersion++;
    });
  }
  evidenceHistory(): ReadonlyArray<Evidence> {
    this.assertWriter();
    return this.db.prepare('SELECT evidence FROM recovery_evidence WHERE record_id=? ORDER BY revision').all(this.id)
      .map(row=>JSON.parse(String(row.evidence)) as Evidence);
  }
  /** Missing evidence is unknown, never proof of rejection or permission to retry. */
  openUncertainty(kind: UncertaintyKind, key: string, question: string): void {
    this.update(state => {
      addUncertainty(state,kind,key,String(this.clean(question)));
    });
  }
  reserveInvestigationCheck(check: string, target: unknown, stateKey: string, question: string, uncertaintyId?: string): { id?: string; cached?: string } {
    let reservation: {id?:string;cached?:string}={};
    this.update(state=>{
      const issue=state.investigations?.slice().reverse().find(item=>item.status==='investigating'&&(!uncertaintyId||item.id===uncertaintyId));
      if(!issue) throw new RecoveryRecordError('No uncertainty is being investigated.');
      const key=hash([check,target,stateKey]);
      const id=randomUUID();issue.checks.push({id,key,question:String(this.clean(question)),check,status:'pending',at:new Date().toISOString()});reservation={id};
    });return reservation;
  }
  completeInvestigationCheck(id: string, result: string): void {
    this.update(state=>{
      const check=state.investigations?.flatMap(issue=>issue.checks).find(check=>check.id===id);
      if(!check||check.status!=='pending') throw new RecoveryRecordError('A stale investigation check cannot replace current evidence.');
      check.status='complete';check.result=String(this.clean(result));state.evidenceVersion++;
    });
  }
  resolveUncertainty(kind: UncertaintyKind, outcome: string, evidence: string, key?: string): void {
    this.update(state=>{
      for(const issue of state.investigations??[]) if(issue.status==='investigating'&&issue.kind===kind&&(!key||issue.key===key)) {
        issue.status='resolved';issue.outcome=outcome;issue.evidence=String(this.clean(evidence));
      }
    });
  }
  settleInvestigations(outcome: string): void {
    this.update(state=>{
      for(const issue of state.investigations??[]) if(issue.status==='investigating') {
        // A completed, canonically checked application resolves form progress,
        // but cannot promote an unverified private credential or infer a send.
        const resolved=['applied','prepared'].includes(outcome)&&issue.kind!=='authentication'
          && (issue.kind!=='submission'||outcome==='applied');
        issue.status=resolved?'resolved':'unresolved';issue.outcome=outcome;
      }
    });
  }
  /** Compact application memory for the applying agent. Model-authored
   * plans remain labelled separately from observed tool outcomes. No file paths,
   * private credentials, browser handles or executable operations are offered. */
  view(): unknown {
    const state = this.snapshot();
    const observation = state.observation as {url?:string;title?:string;fields?:Array<Record<string,unknown>>}|undefined;
    const memory = (state.controls?.memory ?? state.controls?.recovery) as {note?:string;failedInteractions?:unknown}|undefined;
    const summarize = (result: string): unknown => {
      try {
        const value = JSON.parse(result);
        if (Array.isArray(value.results)) return value.results.slice(-6).map((entry: any)=>({index:entry.index,kind:entry.kind,message:summarize(String(entry.message??entry.error??''))}));
        const actual = value.current ?? value;
        return Object.fromEntries(['id','ref','label','value','files','checked','selected','visible','validation','note'].filter(key=>actual[key]!==undefined).map(key=>[key,actual[key]]));
      } catch { return result.slice(0,900); }
    };
    return { id: state.id, revision: state.revision, evidenceVersion: state.evidenceVersion, status: state.status,
      policy: { mode: state.scope.mode, browserWriter: 'applying-agent-only', candidateConfirmationRequired: state.scope.mode !== 'auto', pendingCredentialsAuthorizeSignIn: false },
      completedWork: state.work && { recordedAnswers: state.work.captured.map(answer=>({question:answer.question,answer:answer.answer.slice(0,350)})), verification: 'Recorded answers and generated files are not proof of employer acceptance; inspect actual readbacks.', actions: state.work.actions.slice(-6), resumeId: state.work.resumeUsed,
        coverLetter:state.work.coverLetter?{characters:state.work.coverLetter.length,hash:hash(state.work.coverLetter)}:undefined, generatedFiles: state.work.files.map(file => ({ id: file.id })),
        pendingAuthentication: state.work.pendingCredentials?.map(([site, value]) => ({ site, purpose: value.purpose, state: 'unverified' })) },
      currentObservation:observation&&{url:observation.url,title:observation.title,fields:observation.fields?.filter(field=>field.validationError||field.currentValue).slice(-16)
        .map(field=>({ref:field.ref,label:field.label,value:typeof field.currentValue==='string'?field.currentValue.slice(0,200):undefined,validation:field.validationError}))},
      recentToolEvidence: state.evidence.slice(-6).map(evidence=>({...evidence,result:summarize(evidence.result)})), pendingOperation: state.pending,
      applicationMemory: memory&&{note:memory.note,failedInteractions:memory.failedInteractions}, budget: state.controls?.budget, submissionAttempted: state.submissionAttempted,
      uncertainty: state.investigations?.slice(-8).map(issue=>({...issue,evidence:issue.evidence?.slice(0,1200),checks:issue.checks.map(check=>({...check,result:check.result?.slice(0,900)}))})) };
  }
  finish(status: RecordState['status']): void { this.update(state => { state.status = status; }); }
  release(): void {
    if (this.closed) return;
    try { this.db.prepare('DELETE FROM recovery_writers WHERE worker=? AND token=?').run(this.worker, this.token); }
    finally { this.closed = true; this.db.close(); }
  }
}

export const recoveryContextHash = hash;
