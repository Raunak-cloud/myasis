import type { ToolContext } from './context.js';
import { locate } from './browser-target.js';
import { normaliseBlockedQuestions } from '../blocked-questions.js';
import { captureQuestion } from './question-capture.js';
import { sealQuestionSnapshot, verifiedQuestionSnapshot } from '../question-snapshot-node.js';
import { preparePrivateAuthenticationFields } from '../private-auth-fields.js';

/** The displayed/saved context comes from the grounded employer quote, never
 * an unverified paraphrase that could turn a technical problem into a task. */
export function quotedQuestions(raw: unknown) {
  return normaliseBlockedQuestions(Array.isArray(raw) ? raw.map(item => ({ ...item, question: item?.form_quote, prompt: item?.form_quote })) : []);
}

/** Extract question text from associated employer markup, never from field values
 * or model-authored prose. Ambiguous or stale controls fail closed. */
export async function extractEmployerQuestions(ctx: ToolContext, raw: unknown): Promise<{ questions?: ReturnType<typeof quotedQuestions>; issue?: string }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) return { issue: 'No current question fields were identified.' };
  const grounded: Array<{ field_ref: string; form_quote: string; snapshot: ReturnType<typeof sealQuestionSnapshot> }> = [];
  for (const item of raw) {
    const ref = item?.field_ref;
    if (typeof ref !== 'string') return { issue: 'A current question field was not identified.' };
    const field = ctx.observation.fields.find(f => f.ref === ref || f.kind === 'radio' && f.options?.some((_, i) => `${f.ref}:${i}` === ref));
    const action = ctx.observation.actions.find(a => a.ref === ref);
    if ((!field && !action) || field?.sensitive || field?.privateKind || field?.currentValue === '[private credential]') return { issue: 'The question field is unavailable or private.' };
    const target = locate(ctx.page, field?.kind === 'radio' && field.ref === ref ? `${ref}:0` : ref);
    if (!target || await target.count().catch(() => 0) !== 1) return { issue: 'The question control changed.' };
    const handle=await target.elementHandle({timeout:2500}).catch(()=>null);
    try {
      const frame=await handle?.ownerFrame();
      if(!frame)return {issue:'The current question frame is unavailable.'};
      await preparePrivateAuthenticationFields(frame);
    }finally{await handle?.dispose();}
    const captured = await target.evaluate(captureQuestion, undefined, {timeout:2500}).catch(() => null);
    if (!captured) return {issue:'The full employer question and its control group could not be captured reliably. Inspect the current form and its local heading.'};
    const quote = captured.prompt;
    if (!quote || quote.length > 4000) return { issue: 'The employer question could not be extracted reliably.' };
    // Use the supplied listing identity for provenance, not a browser path
    // that can contain private authentication/reset tokens.
    captured.source.path = ctx.job ? `/jobs/${encodeURIComponent(ctx.job.id)}` : '';
    grounded.push({ field_ref: ref, form_quote: quote, snapshot: sealQuestionSnapshot(captured) });
  }
  const byIdentity=new Map<string,string>();
  for(const question of grounded) {
    const revision=byIdentity.get(question.snapshot.id);
    if(revision&&revision!==question.snapshot.revision)return {issue:'Two current controls share a question identity but have different schemas. Inspect their original section headings before requesting an answer.'};
    byIdentity.set(question.snapshot.id,question.snapshot.revision);
  }
  const distinct=[...new Map(grounded.map(q=>[q.snapshot.id,q])).values()];
  const issue = await questionEvidenceIssue(ctx, distinct);
  if (issue) return { issue };
  return { questions: quotedQuestions(distinct) };
}

/** Ground the question in a current employer control. The agent still judges
 * whether the answer is required, consequential and missing from its evidence.
 * No technical-error vocabulary or candidate-answer classification is used. */
export async function questionEvidenceIssue(ctx: ToolContext, raw: unknown): Promise<string | null> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) return 'Supply between 1 and 30 actual required form questions.';
  if (quotedQuestions(raw).length !== raw.length) return 'Use distinct, complete question labels and employer quotes of at most 500 characters. Credentials and malformed questions cannot create candidate tasks.';
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof item.field_ref !== 'string' || typeof item.form_quote !== 'string'
      || !item.form_quote.trim() || item.form_quote.length > (item.snapshot ? 4000 : 2000)) {
      return 'Each question needs its current field_ref and the complete verbatim form_quote from that control or its question group.';
    }
    const field = ctx.observation.fields.find(field => field.ref === item.field_ref || field.kind === 'radio'
      && field.options?.some((_, index) => `${field.ref}:${index}` === item.field_ref));
    const action = ctx.observation.actions.find(action => action.ref === item.field_ref);
    if (!field && !action) return `The question's field_ref ${JSON.stringify(item.field_ref)} is not a current observed form field. Inspect the actual question before requesting an answer.`;
    if (field?.sensitive || field?.privateKind || field?.currentValue === '[private credential]') return 'Private authentication fields cannot become saved candidate questions. Use the supported authentication tools or report the technical access blocker.';
    // A logical radio ref denotes its whole observed group. Inspecting an
    // option anchors its group text and does not choose/check that option.
    const ref = field?.kind === 'radio' && field.ref === item.field_ref ? `${field.ref}:0` : item.field_ref;
    const target = locate(ctx.page, ref);
    if (!target || await target.count().catch(() => 0) !== 1) return 'The question control changed. Inspect the current form before requesting an answer.';
    const handle = await target.elementHandle({ timeout: 2500 }).catch(() => null);
    try {
      let frame = await handle?.ownerFrame();
      if(!frame)return 'The current question frame is unavailable.';
      await preparePrivateAuthenticationFields(frame);
      for (; frame?.parentFrame(); frame = frame.parentFrame()) {
        const host = await frame.frameElement();
        try { if (!await host.isVisible()) return 'The question belongs to a hidden frame. Inspect its current visible form before requesting an answer.'; }
        finally { await host.dispose(); }
      }
    } finally { await handle?.dispose(); }
    if (item.snapshot !== undefined) {
      if (!verifiedQuestionSnapshot(item.snapshot)) return 'The captured question schema is invalid. Inspect the employer form again.';
      const current = await target.evaluate(captureQuestion, undefined, {timeout:2500}).catch(() => null);
      if (!current) return 'The complete question changed or is no longer available. Inspect the current form again.';
      current.source.path = ctx.job ? `/jobs/${encodeURIComponent(ctx.job.id)}` : '';
      const fresh = sealQuestionSnapshot(current);
      if (fresh.id !== item.snapshot.id || fresh.revision !== item.snapshot.revision) return 'The employer question or its options changed during capture. Inspect the current form again.';
      continue;
    }
    const grounded = await target.evaluate((element, evidence) => {
      const normalise = (text: string): string => text.normalize('NFKC').replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim().toLowerCase();
      const quote = normalise(evidence.quote);
      if (!quote) return false;
      const visible = element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
      const privateNativeWidget = element.matches('input[type="radio"],input[type="checkbox"],input[type="file"],input[role="combobox"],input[aria-haspopup]');
      if (!visible && !privateNativeWidget) return false;
      if (evidence.actionOnly && !['toggle', 'file'].includes(evidence.actionRole)
        && !element.matches('[role="combobox"],[role="listbox"],[role="radiogroup"],[aria-haspopup="listbox"]')) return false;
      const editable = 'input,textarea,select,script,style,[contenteditable="true"],[contenteditable=""],[role="option"]';
      const staticText = (root: Element): string => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        while (walker.nextNode()) {
          const parent = walker.currentNode.parentElement;
          if (!parent || parent.closest(editable) || !parent.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
          parts.push(walker.currentNode.textContent || '');
        }
        return normalise(parts.join(' '));
      };
      // Accessible labels are employer copy even when the visual widget keeps
      // its native input hidden. Read attributes/label nodes, never input values.
      const input = element as HTMLInputElement;
      const labels = [...(input.labels ?? [])].map(label => staticText(label));
      const root = element.getRootNode() as Document | ShadowRoot;
      if (element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) labels.push(normalise(element.getAttribute('aria-label') || ''));
      for (const id of (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const label = root.getElementById(id);
        if (label) labels.push(staticText(label));
      }
      if (labels.some(label => label && label.includes(quote))) return true;
      // Composite dates and radio groups can put their question above several
      // individually labelled controls. The quoted question must be local to
      // this actual control, including through an open shadow host.
      let parent: Element | null = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      for (let depth = 0; parent && depth < 6; depth++) {
        if (parent.matches('body,html')) break;
        if (staticText(parent).includes(quote)) return true;
        const parentRoot = parent.getRootNode();
        parent = parent.parentElement ?? (parentRoot instanceof ShadowRoot ? parentRoot.host : null);
      }
      return false;
    }, { quote: item.form_quote, actionOnly: !field, actionRole: action?.role ?? '' }, { timeout: 2500 }).catch(() => false);
    if (!grounded) return 'The employer quote is not present around this current field. Copy the complete visible group heading, question and relevant instructions, preserving their context. Do not reduce a composite question to one component label; technical recovery choices are not candidate questions.';
  }
  return null;
}
