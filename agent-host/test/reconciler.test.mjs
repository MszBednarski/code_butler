import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayMerge } from '../reconciler/loop.mjs';

test('merge requires approval, successful tests and CI, and the exact reviewed head and base', () => {
  const good = { verdict: { decision: 'approve' }, built: true, ciPassed: true,
    reviewedHead: 'reviewed', baseSha: 'tested-main', currentBase: 'tested-main',
    current: { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: 'reviewed' } } };
  assert.equal(mayMerge(good), true);
  for (const change of [{ verdict: { decision: 'block' } }, { built: false }, { ciPassed: false },
    { currentBase: 'new-main' }, { reviewedHead: 'different-commit' },
    { current: { ...good.current, state: 'closed' } }, { current: { ...good.current, draft: true } },
    { current: { ...good.current, base: { ref: 'release' } } }]) {
    assert.equal(mayMerge({ ...good, ...change }), false);
  }
});
