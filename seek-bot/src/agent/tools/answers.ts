import type { Page } from 'patchright';
import { jitter } from '../../browser.js';
import { fillField, setChecked } from '../../dom.js';
import { answerFields, isRequiredConsent } from '../../llm.js';
import type { FormField } from '../../types.js';
import { locate } from '../raw-tools.js';
import { ANSWER_BATCH, ToolResult, ToolContext, ok } from './context.js';
import { clickRef } from './actions.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

export async function doChooseOption(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const requested = ctx.observation.actions.find(action => action.ref === ref && action.role === 'option');
  const source = ctx.observation.fields.find(field => field.ref === String(args.field_ref ?? ''));
  // The question may also come from the ACTION that opened the list, named in field_ref or clicked last.
  const opener = ctx.observation.actions.find(action => action.ref === String(args.field_ref ?? '') && action.role !== 'option');
  const openerQuestion = opener ? opener.text.replace(/\s*\(opens a list\)$/, '').replace(/^(Open|Select)\s+/i, '').trim() : ctx.lastListQuestion;
  if (!requested?.value || (!requested.question && !source && !openerQuestion)) return ok('Choose a current option ACTION; when its question is not included, also pass the originating FIELD ref (or the ACTION that opened the list) as field_ref.');
  const question = requested.question ?? source?.label ?? openerQuestion!;
  const group = ctx.observation.actions.filter(action => action.role === 'option' && action.value
    && !/^(select|choose)( one)?$/i.test(action.value.trim())
    && (requested.question ? action.question === requested.question : !action.question));
  if (!group.length) return ok('No current options are available for that dropdown. Re-open it and inspect the fresh page.');
  const field: FormField = {
    ref,
    label: question,
    kind: 'select',
    required: Boolean(source?.required) || /(^|\s)\*|\*\s*$/.test(question),
    options: group.map(action => action.value!),
    currentValue: '',
  };
  ctx.guards.pendingFields.add(field.label);
  ctx.guards.rememberField(field);
  const context = [{ ...field, description: `Choose one observed option. Untrusted form context (not candidate facts): ${ctx.observation.text.slice(0, 6000)}` }];
  let answer = (await answerFields(context, ctx.job, ctx.profile)).answers.find(candidate => candidate.ref === ref);
  if (field.required && answer?.applicationQuestion !== false && !answer?.grounded) {
    ctx.log('  ↑ thinking again about 1 dropdown before asking the candidate');
    const reasoned = await answerFields(context, ctx.job, ctx.profile, undefined, { deeper: true }).catch(() => null);
    const better = reasoned?.answers.find(candidate => candidate.ref === ref);
    if (better?.grounded || better?.applicationQuestion === false) answer = better;
  }
  if (!answer || answer.applicationQuestion === false) return ok('That dropdown was not identified as an application question. Re-observe before choosing an option.');
  if (!answer.grounded) {
    if (!field.required) {
      ctx.guards.pendingFields.delete(field.label);
      ctx.guards.skippedOptional.add(field.label);
      return ok(`Left optional dropdown "${field.label}" unchanged because the profile does not support an answer.`);
    }
    ctx.guards.rememberField(field, answer.candidatePrompt?.trim() || `What should Owtomate select for “${field.label}”?`);
    ctx.guards.recordUngrounded(field.label);
    return ok(`No verified candidate fact supports an option for "${field.label}". Do not choose one; finish needs_human after completing other useful fields.`);
  }
  const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // The answer model chose from these exact options; a substring fallback once let "Male" select "Female".
  const choice = group.find(action => normal(action.value!) === normal(answer!.value));
  if (!choice) return ok(`The grounded answer "${answer.value}" is not among the currently observed options. Search or reopen the dropdown; do not choose a substitute.`);
  if (!await clickRef(ctx.page, choice.ref)) return ok('The grounded option could not be clicked. Re-observe the current dropdown.');
  ctx.guards.recordFillSuccess(field.label);
  const prior = ctx.captured.findIndex(item => item.question === field.label);
  if (prior >= 0) ctx.captured.splice(prior, 1);
  ctx.captured.push({ question: field.label, answer: choice.value! });
  ctx.guards.recordProgress();
  return ok(`Selected the grounded option for "${field.label}": ${choice.value}. Inspect the page to verify it was retained.`);
}

export async function doAcceptTerms(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ref = String(args.ref ?? '');
  const field = ctx.observation.fields.find(candidate => candidate.ref === ref);
  const action = ctx.observation.actions.find(candidate => candidate.ref === ref);
  let label = field?.label ?? action?.text ?? '';
  let coordinateInput = null as ReturnType<Page['locator']> | null;
  let coordinateKind: 'native' | 'aria' | null = null;
  if (!field && !action && ctx.observation.screenshot) {
    const gx = Number(args.x);
    const gy = Number(args.y);
    if (gx >= 0 && gx <= 1000 && gy >= 0 && gy <= 1000) {
      const size = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 800 }));
      const target = await ctx.page.evaluate(({ x, y }) => {
        document.querySelector('[data-agent-consent-target]')?.removeAttribute('data-agent-consent-target');
        const element = document.elementFromPoint(x, y);
        const wrapped = element?.closest('label') as HTMLLabelElement | null;
        let input: Element | null = element instanceof HTMLInputElement && element.type === 'checkbox'
          ? element
          : wrapped?.control instanceof HTMLInputElement && wrapped.control.type === 'checkbox'
            ? wrapped.control
            : element?.closest('[role="checkbox"]')
              ?? element?.querySelector('input[type="checkbox"], [role="checkbox"]') as Element | null;
        let context: Element | null = wrapped ?? element;
        // Some design systems render the input and its prose as siblings.
        // Walk only to the nearest block containing exactly one checkbox, so
        // coordinates can never ambiguously select from a group of answers.
        for (let depth = 0; !input && context && depth < 5; depth++, context = context.parentElement) {
          const boxes = context.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
          if (boxes.length === 1) input = boxes[0] as HTMLInputElement;
        }
        if (!input) return null;
        input.setAttribute('data-agent-consent-target', 'true');
        let wording = wrapped?.innerText || input.getAttribute('aria-label') || '';
        for (let prose = input.parentElement, depth = 0; !wording && prose && depth < 6; prose = prose.parentElement, depth++) {
          const text = (prose.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (/\b(terms?|privacy|consent|acknowledg(?:e|ement)|data processing)\b/i.test(text)) wording = text;
        }
        return {
          label: (wording || context?.textContent || input.closest('[role="group"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          kind: input instanceof HTMLInputElement ? 'native' : 'aria',
        };
      }, { x: (gx / 1000) * size.width, y: (gy / 1000) * size.height }).catch(() => null);
      if (target) {
        label = target.label;
        coordinateKind = target.kind as 'native' | 'aria';
        coordinateInput = ctx.page.locator('[data-agent-consent-target="true"]').first();
      }
    }
  }
  if (!field && !action && !coordinateInput && ref) {
    // A consent box inside an embedded form is only in take_snapshot (go.programmed.com.au). Same model judgment as any other.
    const snapshotTarget = locate(ctx.page, ref);
    const found = snapshotTarget ? await snapshotTarget.evaluate((el) => {
      const native = el instanceof HTMLInputElement && el.type === 'checkbox';
      if (!native && el.getAttribute('role') !== 'checkbox') return null;
      let wording = (native ? (el as HTMLInputElement).labels?.[0]?.innerText : '') || el.getAttribute('aria-label') || '';
      for (let prose = el.parentElement, depth = 0; !wording && prose && depth < 6; prose = prose.parentElement, depth++) {
        wording = (prose.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
      return { label: wording.replace(/\s+/g, ' ').trim().slice(0, 300), kind: native ? 'native' as const : 'aria' as const };
    }).catch(() => null) : null;
    if (found && snapshotTarget) {
      label = found.label;
      coordinateKind = found.kind;
      coordinateInput = snapshotTarget;
    }
  }
  if (!field && !action && !coordinateInput) return ok('Use a current FIELD/ACTION ref, a take_snapshot ref for a checkbox inside an embedded form, or screenshot x/y, for the consent checkbox. Re-observe rather than guessing.');
  // Always the model: "Send me job alerts per our Privacy Policy" names privacy
  // and is marketing, which a keyword shortcut used to tick. A failed check refuses.
  if (!(await isRequiredConsent(label).catch(() => false))) {
    await coordinateInput?.evaluate(element => element.removeAttribute('data-agent-consent-target')).catch(() => {});
    return ok('Refused: that control is not visibly labelled as required terms, privacy, consent or acknowledgement. Use the grounded answer tool for application questions.');
  }
  if (coordinateInput) {
    try {
      if (coordinateKind === 'native') {
        if (!await setChecked(coordinateInput, true)) return ok('The consent checkbox did not stay checked. Re-observe the current control.');
      } else {
        await coordinateInput.click({ timeout: 5_000 });
        if (await coordinateInput.getAttribute('aria-checked') !== 'true') return ok('The consent checkbox did not stay checked. Re-observe the current control.');
      }
    } finally {
      await coordinateInput.evaluate(element => element.removeAttribute('data-agent-consent-target')).catch(() => {});
    }
  } else if (field) {
    if (field.kind !== 'checkbox') return ok('The consent FIELD is not a checkbox. Re-observe and use its visible ACTION instead.');
    const input = ctx.page.locator(`[data-field-id="${field.ref}"]`).first();
    if (!await setChecked(input, true)) return ok('The consent checkbox did not stay checked. Re-observe the current control.');
    ctx.guards.pendingFields.delete(field.label);
    ctx.guards.resolveGrounding(field.label);
  } else {
    if (action!.role !== 'toggle') return ok('The consent ACTION is not a checkbox or switch. Re-observe the current control.');
    if (!await clickRef(ctx.page, action!.ref)) return ok('The consent control could not be clicked. Re-observe the current page.');
  }
  ctx.guards.recordProgress();
  return ok(`Accepted the required site consent: "${label}". Inspect the page before continuing.`);
}

/** How many answerable controls the page shows; a change after a fill means the form rebuilt itself. */
export async function formShape(page: Page): Promise<number> {
  /**
   * The form's own controls only. A suggestion list or menu that a fill opens
   * (Oracle's salary combobox, a suburb picker) brings controls of its own
   * and read as the form rebuilding itself, so every answer after the first
   * was deferred and the same batch was asked for again, four times on one
   * APRA page.
   */
  return page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea, [role=combobox], [role=radio], [role=checkbox], [contenteditable=true]')]
    .filter((el) => !el.closest('[role=listbox], [role=menu], [role=option], [aria-live]'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length).catch(() => -1);
}

export async function doAnswerQuestions(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const refs = Array.isArray(args.refs) ? [...new Set(args.refs.map(String))] : [];
  if (!refs.length || refs.some(ref => !ctx.observation.fields.some(field => field.ref === ref))) {
    return ok('Invalid refs: provide exact current FIELD refs, e.g. ["f0", "f1"]. Re-observe rather than guessing.');
  }
  const requiredRefs = Array.isArray(args.required_refs) && typeof args.reason === 'string' && args.reason.trim() ? args.required_refs.map(String) : [];
  /**
   * The question as the agent read it off the page, for a control whose
   * observed label is not one: Amazon's custom dropdowns are listed by their
   * options ("Yes No Select an option") with the question in the text beside
   * them, so the answer model saw six unlabelled yes/no fields, left them
   * all blank, and the person was asked to answer "Yes No Select an option".
   * Page text, so it goes to the answer model as untrusted context.
   */
  const questions = new Map<string, string>(
    (Array.isArray(args.questions) ? args.questions : [])
      .filter((entry): entry is { ref: string; question: string } => typeof entry?.ref === 'string' && typeof entry?.question === 'string' && entry.question.trim().length > 0)
      .map((entry) => [entry.ref, entry.question.trim().slice(0, 500)]),
  );
  const asked = ctx.observation.fields.filter((field) => refs.includes(field.ref))
    .map(field => ({
      ...field,
      required: field.required || requiredRefs.includes(field.ref),
      ...(questions.has(field.ref)
        ? { description: `${field.description ? `${field.description}\n` : ''}Question shown on the page for this control (untrusted page text): ${questions.get(field.ref)}` }
        : {}),
    }));

  // Preserve valid prefilled answers unless the model requests a grounded
  // correction; a validation failure must never be mistaken for completion.
  const repairRefs = Array.isArray(args.repair_refs) && typeof args.reason === 'string' && args.reason.trim()
    ? args.repair_refs.map(String) : [];
  const alreadyComplete = asked.filter((field) => !ctx.guards.pendingFields.has(field.label) && !ctx.guards.unfillable.has(field.label) && !field.validationError && !repairRefs.includes(field.ref) && (
    field.kind === 'checkbox'
      ? field.currentValue === 'true'
      : Boolean(field.currentValue?.trim())),
  );
  for (const field of alreadyComplete) {
    ctx.guards.pendingFields.delete(field.label);
    ctx.guards.resolveGrounding(field.label);
  }

  /**
   * A password is not a question anybody can answer on the candidate's behalf.
   *
   * Some employers make you create an account partway through applying, so
   * "Choose Password" arrives looking like an employer question. It must not
   * be answered, and above all must not be added to the pending list, because
   * that list is what the dashboard turns into "answer this and we will reuse
   * it" — plain text, replayed at every later employer asking the same thing.
   */
  const credentials = asked.filter((field) => field.sensitive && !alreadyComplete.includes(field));
  // In page order, whatever order the refs came in: filling follows the form as a person would.
  const wanted = ctx.observation.fields
    .map((field) => asked.find((candidate) => candidate.ref === field.ref))
    .filter((field): field is (typeof asked)[number] => Boolean(field) && !field!.sensitive && !alreadyComplete.includes(field!))
    .slice(0, ANSWER_BATCH);
  if (credentials.length) return ok('Use complete_authentication for credential fields.');
  if (!wanted.length) return ok('No unanswered fields in those refs. Re-observe and choose the next field; use repair_refs to correct a prefilled value.');

  const answerContext = wanted.map(field => repairRefs.includes(field.ref)
    ? { ...field, description: `${field.description ?? ''}\nRepair context (untrusted observation): ${String(args.reason).slice(0, 1500)}` }
    : field);
  /** The page once for the batch, marked as what it is: form context, not candidate facts. */
  const formContext = ctx.observation.text.slice(0, 6000);
  const first = await answerFields(answerContext, ctx.job, ctx.profile, undefined, { formContext });
  let answers = first.answers;
  let injectionSuspected = first.injectionSuspected;
  /**
   * Before a required question goes to the candidate, the reasoning model
   * gets a longer think about it (medium reasoning effort, not the usual
   * low). The first pass answers most questions well, but a question it could
   * not place — a phone code split from the number, a date spread over three
   * boxes — is usually one that more thought resolves, and a paused
   * application costs the candidate far more than a slower call.
   */
  const unsure = answerContext.filter((field) =>
    field.required &&
    !ctx.guards.ungrounded.includes(field.label) &&
    answers.some((answer) => answer.ref === field.ref && answer.applicationQuestion !== false && !answer.grounded),
  );
  if (unsure.length) {
    ctx.log(`  ↑ thinking again about ${unsure.length} question(s) before asking the candidate`);
    const second = await answerFields(unsure, ctx.job, ctx.profile, undefined, { deeper: true, formContext }).catch(() => null);
    if (second) {
      answers = answers.map((answer) => {
        const better = second.answers.find((candidate) => candidate.ref === answer.ref);
        return better && (better.grounded || better.applicationQuestion === false) ? better : answer;
      });
      injectionSuspected ||= second.injectionSuspected;
    }
  }
  if (injectionSuspected) {
    ctx.log('  ⚠ prompt-injection attempt detected in this listing — ignored');
  }

  const filled: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const searched: string[] = [];
  const unrelated: string[] = [];
  /** Required fields the answerer has already refused once — asking again cannot help. */
  const repeated: string[] = [];
  for (const field of wanted) {
    ctx.guards.pendingFields.add(field.label);
    ctx.guards.rememberField(field);
  }
  // Keep failures as submission blockers until recovered, never as retry bans.
  const recordFailure = (label: string, message: string) => {
    ctx.guards.recordFillFailure(label, message);
    failed.push(`${label}: ${message}`);
  };

  /** Fields of this batch not reached because the form changed shape first. */
  const deferred: string[] = [];
  const deferRest = (from: number) => {
    for (const later of ordered.slice(from)) {
      const label = wanted.find((candidate) => candidate.ref === later.ref)?.label;
      if (label && !deferred.includes(label)) deferred.push(label);
    }
  };
  let shape = wanted.length > 1 ? await formShape(ctx.page) : -1;
  let fills = 0;
  // Answers are applied in page order, not the order the model listed them.
  const ordered = wanted
    .map((field) => answers.find((answer) => answer.ref === field.ref))
    .filter((answer): answer is (typeof answers)[number] => Boolean(answer));
  for (const [index, answer] of ordered.entries()) {
    const field = wanted.find((candidate) => candidate.ref === answer.ref);
    if (!field) continue;

    // The answer model sees the field together with the job and can distinguish
    // an application question from a site search box or misread section title.
    // Only genuine application questions may become candidate tasks.
    if (answer.applicationQuestion === false) {
      ctx.guards.releaseAsSiteControl(field.label);
      unrelated.push(`${field.ref} (${field.label})`);
      continue;
    }

    /**
     * Unsupported answers are never invented. A required one blocks
     * submission until a person resolves it; an optional one is simply left
     * blank — referral fields and "anything else?" boxes used to stop whole
     * applications for no reason.
     */
    if (!answer.grounded) {
      if (!field.required) {
        ctx.guards.pendingFields.delete(field.label);
        ctx.guards.skippedOptional.add(field.label);
        skipped.push(field.label);
        continue;
      }
      ctx.guards.rememberField(
        field,
        answer.candidatePrompt?.trim() || field.description?.trim() || `What should Owtomate enter for “${field.label}”?`,
      );
      if (ctx.guards.ungrounded.includes(field.label)) repeated.push(field.label);
      ctx.guards.recordUngrounded(field.label);
      continue;
    }

    const value = answer.value;
    // A person's pause between one question and the next, as the separate turns used to give.
    if (fills++) await jitter(350, 900);
    try {
      const input = ctx.page.locator(`[data-field-id="${field.ref}"]`).first();
      const selected = field.autocomplete && !field.validationError && field.currentValue?.trim() === value.trim()
        && await input.getAttribute('aria-expanded').catch(() => null) === 'false';
      const interaction = args.interaction === 'type' ? 'type' : args.interaction === 'search' || field.autocomplete ? 'search' : 'type';
      if (!selected) await fillField(ctx.page, field, value, interaction);
      if (interaction === 'search' && field.autocomplete && !selected) {
        searched.push(field.label);
        // Its suggestions need choosing before anything else on the form is touched.
        deferRest(index + 1);
        break;
      }
    } catch (error) {
      /**
       * A field that is no longer on the page did not reject the answer: the
       * page moved on (Indeed's Continue had already advanced past the phone
       * number). Holding it as an unconfirmed required answer blocked the
       * submit for a field that was never wrong, and the agent went back to
       * chase it until the attempt died.
       */
      const gone = (await ctx.page.locator(`[data-field-id="${field.ref}"]`).count().catch(() => 0)) === 0;
      if (gone) {
        ctx.guards.pendingFields.delete(field.label);
        ctx.guards.resolveGrounding(field.label);
        failed.push(`${field.label}: no longer on the page — the form has moved on; re-observe and continue from the current page.`);
        continue;
      }
      recordFailure(field.label, (error as Error).message);
      // Recovery is a new model decision with a fresh observation, not a
      // hidden repeat of the same operation inside this tool.
      continue;
    }
    ctx.guards.recordFillSuccess(field.label);
    const prior = ctx.captured.findIndex(item => item.question === field.label);
    if (prior >= 0) ctx.captured.splice(prior, 1);
    ctx.captured.push({ question: field.label, answer: value });
    filled.push(`${field.label} → ${value.slice(0, 60)}${answer.rationale ? ` (${answer.rationale.slice(0, 500)})` : ''}`);
    if (shape >= 0 && index < ordered.length - 1) {
      const now = await formShape(ctx.page);
      if (now !== shape) {
        // The form rebuilt itself: the answers still to go were chosen for the form as it was.
        deferRest(index + 1);
        break;
      }
      shape = now;
    }
  }

  if (filled.length) ctx.guards.recordProgress();
  const ungroundedNow = ctx.guards.ungrounded.length;
  return ok(
    (failed.length
      ? `Not accepted; re-observe and recover:\n${failed.join("\n")}\n` +
        'If a failed field is a custom dropdown, operate it the way a person does: click its control (or press_key ArrowDown ' +
        'with its ref) so its entries appear as [option] actions, then call choose_option with the matching option ref and ' +
        'this field as field_ref. A widget that rejects automatic filling is not a missing answer.\n'
      : '') +
    `Verified ${filled.length} field(s):\n${filled.map((line) => `  - ${line}`).join('\n')}` +
      (deferred.length ? `\nNot filled yet, because the form changed after an answer: ${deferred.join('; ')}. Re-observe and answer them with their fresh refs.` : '') +
      (searched.length ? `\nSearch text entered, not yet selected: ${searched.join('; ')}. Its suggestions now show as [option] actions: call choose_option with the matching option ref and this field as field_ref. If no options appear, open the list with click or press_key ArrowDown first.` : '') +
      (skipped.length ? `\nLeft blank (optional, nothing in the profile supports an answer): ${skipped.join('; ')}` : '') +
      (unrelated.length ? `\nNot application questions, so left to you as site controls: ${unrelated.join('; ')}. Operate them with fill_element (give the value, e.g. the candidate's suburb for a location search), type_text or click, then pick the observed option.` : '') +
      (repeated.length
        ? `\nSTOP asking about: ${repeated.join('; ')}. These required questions have no answer in the candidate's profile and calling answer_questions again cannot change that — only the candidate can supply them. Finish with status "needs_human" now.`
        : '') +
      (ungroundedNow
        ? `\nWARNING: ${ungroundedNow} answer(s) could not be grounded in the candidate profile. This application cannot be submitted; finish with status "needs_human" once you have nothing else useful to do.`
        : ''),
  );
}
