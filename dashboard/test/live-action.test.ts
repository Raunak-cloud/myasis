import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialLiveView, liveViewState } from '../src/live-action-state.ts';
import { initialLiveWorkers, liveWorkersState } from '../src/live-action-state.ts';

test('a ready connection and blank-tab frames never replace the waiting screen', () => {
  let view = liveViewState(initialLiveView, { type: 'attached', target: { url: 'about:blank' } });
  view = liveViewState(view, { type: 'ready' });
  view = liveViewState(view, { type: 'frame', data: 'white-page' });
  assert.equal(view.phase, 'waiting');
  assert.equal(view.frame, null);
});

test('parallel frames, page changes and errors remain isolated to the owning worker', () => {
  let views = liveWorkersState(initialLiveWorkers, { type: 'workers', workers: [{ id: 'seek', label: 'SEEK' }, { id: 'indeed', label: 'Indeed' }] });
  for (const id of ['seek', 'indeed']) {
    views = liveWorkersState(views, { type: 'attached', workerId: id, target: { url: `https://${id}.example.test` } });
    views = liveWorkersState(views, { type: 'frame', workerId: id, data: id });
    views = liveWorkersState(views, { type: 'displayed', workerId: id, data: `data:image/jpeg;base64,${id}` });
  }
  const indeed = views[1];
  views = liveWorkersState(views, { type: 'navigated', workerId: 'seek', url: 'https://employer.example.test' });
  assert.equal(views[0].view.frame, null);
  assert.equal(views[1], indeed);
  views = liveWorkersState(views, { type: 'image-error', workerId: 'seek' });
  assert.equal(views[0].view.phase, 'disconnected');
  assert.equal(views[1].view.phase, 'live');
  views = liveWorkersState(views, { type: 'waiting', workerId: 'seek', finished: true });
  assert.equal(views[0].view.phase, 'finished');
  assert.equal(views[1], indeed);
  views = liveWorkersState(views, { type: 'closed' });
  assert.ok(views.every(worker => worker.view.phase === 'disconnected'));
});

test('the picture becomes live only after a real page frame loads; navigation clears the previous page', () => {
  let view = liveViewState(initialLiveView, { type: 'attached', target: { url: 'https://example.test/job' } });
  view = liveViewState(view, { type: 'ready' });
  view = liveViewState(view, { type: 'frame', data: 'first' });
  assert.equal(view.phase, 'waiting');
  view = liveViewState(view, { type: 'displayed', data: view.frame! });
  assert.equal(view.phase, 'live');
  view = liveViewState(view, { type: 'navigated', url: 'https://example.test/application' });
  assert.equal(view.phase, 'waiting');
  assert.equal(view.frame, null);
  // A late image event from the old tab must not restore a stale picture.
  view = liveViewState(view, { type: 'displayed', data: 'data:image/jpeg;base64,first' });
  assert.equal(view.phase, 'waiting');
});

test('disconnect and decode errors remove stale pictures; retry starts clean', () => {
  const live = { phase: 'live' as const, hasPage: true, frame: 'last-picture' };
  for (const type of ['error', 'closed', 'detached', 'image-error'] as const) {
    const view = liveViewState(live, { type });
    assert.equal(view.phase, 'disconnected');
    assert.equal(view.frame, null);
    assert.deepEqual(liveViewState(view, { type: 'reset' }), initialLiveView);
  }
});
