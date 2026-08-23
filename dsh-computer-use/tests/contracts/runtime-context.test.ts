/**
 * Regression tests for the per-call execution context (AsyncLocalStorage).
 *
 * The approval call binding and observation owner used to be module-level
 * globals, so two concurrent tool calls interleaved: while chain A's action
 * sat in the approval dialog, chain B's call replaced the globals and A's
 * approval request was filed under B's toolName/callId — the user approved
 * one action and a different one ran. These tests pin the isolation guarantee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithCallContext, sessionScopeOf, __activeCallContextForTest, } from '../../src/runtime.ts';

const callOf = (name: string) => ({
  name,
  callId: `call-${name}`,
  agent: { id: `${name}-agent`, session: { id: `${name}-session` } },
  signal: undefined,
});

function activeBinding() {
  const ctx = __activeCallContextForTest();
  return ctx ? Object.values(ctx)[0] : null;
}

function activeOwner() {
  const ctx = __activeCallContextForTest();
  return ctx ? ctx.owner : null;
}

test('runWithCallContext binds the call and derived owner to the chain', async () => {
  const call = callOf('alpha');
  await runWithCallContext(call, async () => {
    assert.equal(activeBinding(), call);
    assert.deepEqual(activeOwner(), { sessionId: 'alpha-session', agentId: 'alpha-agent' });
    await new Promise((r) => setTimeout(r, 1));
    // Still bound after an await hop.
    assert.equal(activeBinding(), call);
  });
  // Outside any chain there is no active context.
  assert.equal(__activeCallContextForTest(), null);
});

test('concurrent chains keep their own binding (no cross-session approval swap)', async () => {
  const results: Record<string, unknown> = {};
  const chain = (name: string, holdMs: number) =>
    runWithCallContext(callOf(name), async () => {
      await new Promise((r) => setTimeout(r, holdMs));
      // The slower chain resumes after the faster one started: it must still
      // see its OWN binding, not the most recent global writer.
      results[name] = (activeBinding() as { name?: string } | null)?.name;
    });
  await Promise.all([chain('slow-a', 20), chain('fast-b', 1)]);
  assert.equal(results['slow-a'], 'slow-a');
  assert.equal(results['fast-b'], 'fast-b');
});

test('sessionScopeOf degrades missing fields to a stable unknown scope', () => {
  assert.deepEqual(sessionScopeOf(undefined), { sessionId: 'unknown', agentId: 'unknown' });
  assert.deepEqual(sessionScopeOf({ agent: { session: { sessionId: 'legacy' } } }), {
    sessionId: 'legacy',
    agentId: 'unknown',
  });
});
