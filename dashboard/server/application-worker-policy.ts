/** Server-owned admin pilot; never enable through a run request or saved user setting. */
export function applicationWorkerEnvironment(admin: boolean, mode: 'search' | 'live', enabled: string | undefined): Record<string, string> {
  return { APPLICATION_WORKERS: admin && mode === 'live' && enabled === 'true' ? '2' : '1' };
}
