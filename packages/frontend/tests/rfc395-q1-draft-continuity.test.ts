import { afterEach, expect, it, vi } from 'vitest'
import { DRAFT_DB_NAME, DRAFT_DB_VERSION, resetDraftDbForTest } from '../src/lib/draftDb'
import { clarifyDraftKey, getClarifyDraft } from '../src/lib/clarify/draftStore'
import { draftKey, getDraft } from '../src/lib/review/draftStore'
import { taskWizardDraftKey, taskWizardNewDraftSourceId } from '../src/lib/task-wizard-draft'
import { loadViewed } from '../src/lib/diffViewed'

const clarify = { taskId: 'old-task', intermediaryNodeRunId: 'old-run', roundId: 'old-round' }
const review = {
  taskId: 'old-task',
  nodeRunId: 'old-run',
  docVersionId: 'old-doc',
  anchorHash: 'old-anchor',
}
afterEach(() => {
  resetDraftDbForTest()
  vi.unstubAllGlobals()
})
it('opens the epoch-1 draft database and reads existing keys without an upgrade or delete', async () => {
  const values = new Map([
    ['clarify-round:old-task:old-run:old-round', '[{"questionId":"q","customText":"unsent"}]'],
    ['old-task:old-run:old-doc:old-anchor', 'unsent review'],
  ])
  const operations: string[] = []
  const db = {
    transaction: (_store: string, mode: string) => {
      operations.push(mode)
      return {
        objectStore: () => ({
          get: (key: string) => {
            const req = { result: values.get(key), onsuccess: null } as unknown as IDBRequest
            queueMicrotask(() => req.onsuccess?.call(req, new Event('success')))
            return req
          },
        }),
      }
    },
  } as unknown as IDBDatabase
  const open = vi.fn((name: string, version: number) => {
    expect([name, version]).toEqual(['agent-workflow-drafts', 2])
    const req = { result: db, onsuccess: null } as unknown as IDBOpenDBRequest
    queueMicrotask(() => req.onsuccess?.call(req, new Event('success')))
    return req
  })
  vi.stubGlobal('indexedDB', { open })
  expect([DRAFT_DB_NAME, DRAFT_DB_VERSION]).toEqual(['agent-workflow-drafts', 2])
  expect(clarifyDraftKey(clarify)).toBe('clarify-round:old-task:old-run:old-round')
  expect(draftKey(review)).toBe('old-task:old-run:old-doc:old-anchor')
  expect(await getClarifyDraft(clarify)).toEqual([{ questionId: 'q', customText: 'unsent' }])
  expect(await getDraft(review)).toBe('unsent review')
  expect(operations).toEqual(['readonly', 'readonly'])
  expect(values.size).toBe(2)
})
it('relaunch, schedule and workflow revision keys retain their original identities', () => {
  expect(taskWizardDraftKey({ actorId: 'u', flow: 'relaunch', sourceId: 'old-task' })).toBe(
    'aw:task-wizard-draft:v1:u:relaunch:old-task',
  )
  expect(taskWizardDraftKey({ actorId: 'u', flow: 'edit-scheduled', sourceId: 'schedule/1' })).toBe(
    'aw:task-wizard-draft:v1:u:edit-scheduled:schedule%2F1',
  )
  const identity = {
    scheduled: false,
    entry: { kind: 'workflow' as const, resourceId: 'workflow', workflowVersion: 4 },
  }
  expect(taskWizardNewDraftSourceId(JSON.parse(JSON.stringify(identity)))).toBe(
    taskWizardNewDraftSourceId(identity),
  )
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'awf.diffViewed.old-task' ? '["src/old.ts"]' : null),
  })
  expect([...loadViewed('old-task')]).toEqual(['src/old.ts'])
})
