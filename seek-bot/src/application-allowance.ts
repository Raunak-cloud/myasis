import { AsyncLocalStorage } from 'node:async_hooks';

type ApplicationAllowance = (external: boolean) => boolean | Promise<boolean>;
const allowanceScope = new AsyncLocalStorage<ApplicationAllowance>();

/** Account quota only: no answer, duplicate, reservation or receipt policy. */
export function withApplicationAllowance<T>(beforeSubmit: ApplicationAllowance, action: () => T): T {
  return allowanceScope.run(beforeSubmit, action);
}

/** An application may change destination after its initial run slot is acquired. */
export async function applicationAllowance(external: boolean): Promise<boolean> {
  return await (allowanceScope.getStore()?.(external) ?? true);
}
