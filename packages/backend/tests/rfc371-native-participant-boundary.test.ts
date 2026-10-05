import { readTaskAgentSources } from './helpers/taskAgentSource'
// RFC-371: the legacy Runner reaches the original Task finalizer through the
// exact public participant; it must not grow inbound application-layer debt.
import { expect, test } from 'bun:test'

import { finalizeNativeUsageInvocation } from '@/modules/task-execution/public/participants'
import { finalizeNativeUsageInvocation as originalFinalizer } from '@/modules/task-execution/application/finalizeNativeUsageInvocation'

test('the public participant is the original EOF finalizer and Runner uses that boundary', () => {
  expect(finalizeNativeUsageInvocation).toBe(originalFinalizer)
  const runner = readTaskAgentSources()
  expect(runner).toContain(
    "import { finalizeNativeUsageInvocation } from '@/modules/task-execution/public/participants'",
  )
  expect(runner).not.toContain(
    "from '@/modules/task-execution/application/finalizeNativeUsageInvocation'",
  )
})
