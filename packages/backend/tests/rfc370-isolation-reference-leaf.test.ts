// RFC-370: importing pure isolation addresses must not re-enter the SC query selector.
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as leaf from '@/modules/source-control/infrastructure/local/isolationReferences'
import * as native from '@/modules/source-control/infrastructure/local/nodeIsolation'
import { selectRepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'
import { createFileRepositoryWorkspaceReadQueries } from '@/modules/source-control/composition'

test('native isolation addresses retain one shared leaf function identity', () => {
  expect(native.isoKeyOf).toBe(leaf.isoKeyOf)
  expect(native.isoWorktreePathFor).toBe(leaf.isoWorktreePathFor)
})

test('the real selected native reader preserves persisted generation and pre-column fallback references', async () => {
  const queries = selectRepositoryWorkspaceReadQueries(createFileRepositoryWorkspaceReadQueries())
  const storageRootRef = join(tmpdir(), 'aw-rfc370-reference-only')
  const taskId = 'task-中文'
  for (const entry of [
    {
      persistedWorkspaceRef: join(storageRootRef, 'iso', taskId, 'old-key-3'),
      nodeRunId: 'retry-row',
      expectedKey: 'old-key-3',
    },
    { persistedWorkspaceRef: null, nodeRunId: 'original-row', expectedKey: 'original-row' },
    { persistedWorkspaceRef: '', nodeRunId: 'legacy-row', expectedKey: 'legacy-row' },
  ]) {
    expect(
      await queries.isolationRoot({
        storageRootRef,
        taskId,
        nodeRunId: entry.nodeRunId,
        persistedWorkspaceRef: entry.persistedWorkspaceRef,
      }),
    ).toBe(join(storageRootRef, 'iso', taskId, entry.expectedKey))
  }
})
