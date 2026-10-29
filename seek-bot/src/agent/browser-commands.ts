/** Action intent is supplied by the applying agent. It is recovery/spending
 * bookkeeping, never a permission grant or proof that the browser changed.
 * Unlabelled scripts remain potentially mutating. Semi-auto script restrictions
 * and marked-send approval apply separately, regardless of intent. */
export function changesBrowserState(command: Record<string, unknown>): boolean {
  if (command.sends_application === true) return true;
  if (command.action === 'script') return command.script_intent !== 'inspect';
  return ['click', 'fill', 'type', 'select', 'check', 'press', 'navigate', 'dialog', 'set_input_files'].includes(String(command.action));
}
