// RFC-370: the original scratch helper consumes the selected storage owner,
// preserves running turns and retains native failure/log/count behavior.
import { expect, test } from 'bun:test'
import { sweepIntentScratch } from '@/modules/intent/application/maintenance'
import type { IntentScratchStore } from '@/modules/intent/application/ports/intentScratchStore'
import { createLogger } from '@/util/log'
import { deferred } from './helpers/taskHostExecution'

test('delayed non-file enumeration keeps the original methods and skips the actual running turns', async () => {
  const entered = deferred(),
    release = deferred(),
    removed: string[] = [],
    warnings: unknown[] = []
  const scratch: IntentScratchStore = {
    async staleTurnIds() {
      expect(this).toBe(scratch)
      entered.resolve()
      await release.promise
      return ['old', 'running', 'failed']
    },
    async remove(id) {
      expect(this).toBe(scratch)
      removed.push(id)
      if (id === 'failed') throw new Error('original content owner refused removal')
    },
  }
  const persistence = {
    async listRunningTurnIds(ids: readonly string[]) {
      expect(this).toBe(persistence)
      expect(ids).toEqual(['old', 'running', 'failed'])
      return new Set(['running'])
    },
  }
  const log = {
    ...createLogger('intent-scratch-port'),
    info() {},
    warn(_message: string, fields?: Record<string, unknown>) {
      warnings.push(fields)
    },
  }
  const sweeping = sweepIntentScratch(persistence, scratch, 24, log)
  await entered.promise
  scratch.remove = () => {
    throw new Error('replacement storage must not run')
  }
  persistence.listRunningTurnIds = async () => new Set()
  release.resolve()
  expect(await sweeping).toBe(1)
  expect(removed).toEqual(['old', 'failed'])
  expect(warnings).toEqual([{ dir: 'failed', err: 'original content owner refused removal' }])
})
