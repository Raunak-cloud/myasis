import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairRetryAllowed, type RepairRetryEvidence } from './repair-retry-policy.js';

const valid: RepairRetryEvidence = { ownerId: '1', ownerEmail: 'raunak.vision@gmail.com', activeAdmin: true,
  originalRunFinished: true, currentRunActive: false, schedulePaused: false, repairValidated: true,
  outcome: 'failed', sendState: 'proven-not-attempted', mode: 'semi-auto', candidateApprovedRevision: true, sameJobAndRevision: true };

test('retry stays scoped to the confirmed admin job and requires a proven unsent attempt', () => {
  assert.equal(repairRetryAllowed(valid), true);
  for (const patch of [
    { ownerId: '183' }, { ownerEmail: 'other@example.com' }, { activeAdmin: false }, { originalRunFinished: false },
    { currentRunActive: true }, { schedulePaused: true }, { repairValidated: false }, { outcome: 'submitted' },
    { outcome: 'prepared' }, { outcome: 'needs-attention' }, { sendState: 'unknown' }, { sendState: 'uncertain' },
    { sendState: 'confirmed' }, { candidateApprovedRevision: false }, { sameJobAndRevision: false },
  ]) assert.equal(repairRetryAllowed({ ...valid, ...patch } as RepairRetryEvidence), false, JSON.stringify(patch));
  assert.equal(repairRetryAllowed({ ...valid, mode: 'auto', candidateApprovedRevision: false }), true);
  assert.equal(repairRetryAllowed({ ...valid, mode: 'prepare', candidateApprovedRevision: false }), true);
  assert.equal(repairRetryAllowed({ ...valid, currentRunActive: undefined } as unknown as RepairRetryEvidence), false);
  assert.equal(repairRetryAllowed({ ...valid, schedulePaused: undefined } as unknown as RepairRetryEvidence), false);
  assert.equal(repairRetryAllowed({ ...valid, sameJobAndRevision: 'yes' } as unknown as RepairRetryEvidence), false);
});
