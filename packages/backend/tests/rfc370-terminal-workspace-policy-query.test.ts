// RFC-370: terminal workspace policy must await the selected current setting,
// preserve attribution-before-config ordering, and retain lifecycle fallback.
import { afterEach, describe, expect, test } from 'bun:test'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'
import {
  registerTerminalWorkspacePrunePolicy,
  resolveTerminalWorkspacePruneDecision,
  type TerminalWorkspacePrunePolicy,
} from '@/platform/persistence/terminalWorkspacePrune'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

const row: Parameters<TerminalWorkspacePrunePolicy>[0] = {
  taskId: 'hosted-terminal-task',
  spaceKind: 'remote',
  workspacePruningAt: null,
  workspacePruneCause: null,
  workspacePrunedAt: null,
}

afterEach(() => registerTerminalWorkspacePrunePolicy(null))

describe('RFC-370 asynchronous terminal workspace setting', () => {
  test('awaits the current setting with its receiver and rereads after edits', async () => {
    const entered = deferred<void>()
    const setting = deferred<boolean>()
    let current = true
    let reads = 0
    const calls: string[] = []
    const dependencies: Parameters<typeof createWebhookTerminalWorkspacePrunePolicy>[0] = {
      attribution: {
        async load(taskId: string) {
          expect(taskId).toBe(row.taskId)
          calls.push('attribution')
          return { webhookTriggerId: 'trigger-1', eventSubscriptionId: null }
        },
      },
      async enabled() {
        expect<unknown>(this).toBe(dependencies)
        calls.push('configuration')
        reads += 1
        entered.resolve()
        return reads === 1 ? setting.promise : current
      },
    }
    const policy = createWebhookTerminalWorkspacePrunePolicy(dependencies)
    let settled = false
    const pending = policy(row, 'done').finally(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(calls).toEqual(['attribution', 'configuration'])
      expect(settled).toBe(false)
      setting.resolve(true)
      expect(await pending).toEqual({ prune: true, cause: 'webhook-terminal' })
      current = false
      expect(await policy(row, 'canceled')).toEqual({ prune: false })
      expect(reads).toBe(2)
    } finally {
      setting.resolve(false)
      await pending
    }
  })

  test('missing attribution returns before touching configuration', async () => {
    const policy = createWebhookTerminalWorkspacePrunePolicy({
      attribution: {
        async load() {
          return null
        },
      },
      async enabled() {
        throw new Error('unattributed task must not read configuration')
      },
    })
    expect(await policy(row, 'done')).toEqual({ prune: false })
  })

  test('rejected selected setting retains lifecycle false fallback', async () => {
    const failure = new Error('selected configuration unavailable')
    const policy = createWebhookTerminalWorkspacePrunePolicy({
      attribution: {
        async load() {
          return { webhookTriggerId: null, eventSubscriptionId: 'subscription-1' }
        },
      },
      async enabled() {
        throw failure
      },
    })
    await expect(policy(row, 'done')).rejects.toBe(failure)
    registerTerminalWorkspacePrunePolicy(policy)
    expect(await resolveTerminalWorkspacePruneDecision(row, 'done')).toEqual({ prune: false })
  })
})
