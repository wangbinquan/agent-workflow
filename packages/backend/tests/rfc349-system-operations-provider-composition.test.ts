// RFC-349 — provider-aware bootstrap injects physical recovery operations into
// System Operations without exposing a DbClient through the public surface.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeSystemOperationsWithRecoveryAdapter,
  type SystemOperationsRecoveryAdapter,
} from '@/modules/system-operations/composition'
import type { LocalSystemOperationContext } from '@/modules/system-operations/public/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-349 provider-aware System Operations composition', () => {
  test('projects the injected provider backup through the existing command', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'rfc349-provider-system-operations-'))
    roots.push(appHome)
    const requests: boolean[] = []
    const adapter: SystemOperationsRecoveryAdapter = {
      backup: {
        async request(input) {
          requests.push(input.includeWorktrees)
          return {
            path: join(appHome, 'backups', 'postgresql.tar.gz'),
            sizeBytes: 42,
            contents: { workflows: 1, skills: 2, db: true, config: true },
          }
        },
      },
      restore: {
        async plan() {
          throw new Error('not used')
        },
        async stage() {
          throw new Error('not used')
        },
        status() {
          return { pending: null, failed: [] }
        },
        cancel() {
          return { cleared: false }
        },
        async activateLocal() {
          throw new Error('not used')
        },
      },
    }
    const module = composeSystemOperationsWithRecoveryAdapter({ adapter, appHome })

    await expect(
      module.application.commands.requestBackup.execute({} as LocalSystemOperationContext, {
        includeWorktrees: true,
      }),
    ).resolves.toEqual({
      path: join(appHome, 'backups', 'postgresql.tar.gz'),
      sizeBytes: 42,
      contents: { workflows: 1, skills: 2, db: true, config: true },
    })
    expect(requests).toEqual([true])
    expect(String(module.operations.requestBackup.id)).toBe('system-operations.request-backup.v1')
  })
})
