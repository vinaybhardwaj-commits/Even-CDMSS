/**
 * The paired-audit fence must refuse every production writer before SQL, including after
 * exitLabExecution — that is the door the repair adapter uses to call saveOpdAudit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterOpdLabWriteFence, OpdLabWriteForbidden } from '../opd-lab-write-guard';
import { exitLabExecution } from '../lab-execution-context';
import { saveOpdAudit, updateOpdAudit } from '../opd-audit-store';
import { persistLongitudinal, replayLongitudinal, runLongitudinalPass } from '../opd-longitudinal';
import { insertDecision, insertQueueDisposition } from '../opd-triage-store';
import { applyDoctorResponse, applySignalAction, mintOrUpdateSignal, withdrawSignal } from '../opd-gov-signal-store';

async function forbidden(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (e: Error) => {
    assert.ok(e instanceof OpdLabWriteForbidden, `expected OpdLabWriteForbidden, got ${e?.name}: ${e?.message}`);
    assert.equal((e as OpdLabWriteForbidden).code, 'OPD_LAB_WRITE_FORBIDDEN');
    return true;
  });
}

test('override/lab mode throws before any production audit writer runs', async () => {
  await enterOpdLabWriteFence(async () => {
    await forbidden(() => saveOpdAudit(undefined as never));
    await forbidden(() => updateOpdAudit(undefined as never));
    await forbidden(() => persistLongitudinal('uid', 'engine', undefined as never));
    await forbidden(() => runLongitudinalPass(undefined as never));
    await forbidden(() => replayLongitudinal(undefined as never));
    await forbidden(() => insertDecision(undefined as never));
    await forbidden(() => insertQueueDisposition(undefined as never));
    await forbidden(() => mintOrUpdateSignal(undefined as never));
    await forbidden(() => withdrawSignal('d', 's', null, null, null));
    await forbidden(() => applyDoctorResponse(undefined as never, undefined as never));
    await forbidden(() => applySignalAction(undefined as never, undefined as never));
  });
});

test('leaving the lab IO fence does not open the production writers', async () => {
  await enterOpdLabWriteFence(async () => {
    await exitLabExecution(() => forbidden(() => saveOpdAudit(undefined as never)));
  });
});

test('outside the fence a bad call is an ordinary failure, not the lab refusal', async () => {
  await assert.rejects(
    () => saveOpdAudit(undefined as never),
    (e: Error) => !(e instanceof OpdLabWriteForbidden),
  );
});
