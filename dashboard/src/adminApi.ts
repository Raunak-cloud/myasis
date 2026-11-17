import {dashboardGet} from './dashboard-requests.js';
/** Every admin request, with the server's own error message preserved. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const readOnly=init===undefined;
  const response = await (readOnly?dashboardGet(`/api/admin${path}`):fetch(`/api/admin${path}`, {
    ...init,
    headers: init?.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  }));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string })?.error ?? `Request failed (${response.status}).`);
  return body as T;
}
