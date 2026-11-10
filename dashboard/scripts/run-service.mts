// A sibling PM2 process, never a child of the dashboard's process tree.
delete process.env.OWTOMATE_RUN_SERVICE_CLIENT;
const { runner } = await import('../server/runner.js');
const { serveRuns } = await import('../server/run-service.js');
const service = await serveRuns(runner as import('../server/runner.js').RunPool);
console.log('[applications] independent application service ready');
let draining = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (draining) return;
  draining = true;
  console.log('[applications] waiting for active applications before service shutdown');
  void service.drain().then(() => process.exit(0));
});
