import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import {
  WORKTREE_FILE_MAX_BYTES,
  worktreeFileResponseSchema,
  worktreeTreeResponseSchema,
} from '@agent-workflow/shared'
import { tasks, workflows } from '@/db/schema'
import type {
  WorkspaceContentEffects,
  WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import type {
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceEntryPage,
  BoundedWorkspaceContent,
} from '@/modules/source-control/public/types'
import { NotFoundError } from '@/util/errors'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const token = 'b'.repeat(64)
const bytes = Buffer.concat([Buffer.from('中😀'), Buffer.from([0, 255, 254, 128])])

class SelectedContent implements WorkspaceContentEffects, WorkspaceContentEffectsFactory {
  readonly #bytes: Buffer
  readonly entered = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  readonly bindings: string[] = []
  readonly requests: Array<WorkspaceListRequest | WorkspaceReadRequest> = []

  constructor(content: Buffer) {
    this.#bytes = content
    Object.freeze(this)
  }

  bind(reference: string): WorkspaceContentEffects {
    this.bindings.push(reference)
    return this
  }

  async list(request: WorkspaceListRequest): Promise<WorkspaceEntryPage> {
    this.requests.push(request)
    this.entered.resolve()
    await this.release.promise
    return {
      entries: [{ name: 'selected.bin', kind: 'file', size: this.#bytes.length }],
      nextOffset: null,
      truncated: false,
    }
  }

  async read(request: WorkspaceReadRequest): Promise<BoundedWorkspaceContent> {
    this.requests.push(request)
    this.entered.resolve()
    await this.release.promise
    if (request.relativeFile === 'missing.bin')
      throw new NotFoundError('worktree-file-not-found', 'selected object is missing')
    const end = Math.min(this.#bytes.length, request.offset + request.maxBytes)
    return {
      encoding: 'base64',
      content: this.#bytes.subarray(request.offset, end).toString('base64'),
      size: this.#bytes.length,
      offset: request.offset,
      nextOffset: end < this.#bytes.length ? end : null,
      oversized: this.#bytes.length > WORKTREE_FILE_MAX_BYTES,
    }
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected workspace content at actual HTTP roots',
  { token, dbVersion: 17, opencodeVersion: null, tempPrefix: 'rfc370-workspace-content-root-' },
  (scope) => {
    async function fixture(content: SelectedContent) {
      const { app } = await scope.open({ workspaceContent: content })
      const id = randomUUID()
      const snapshot = '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[],"outputs":[]}'
      const reference = `logical:workspace:${id}`
      await scope.harness.db.insert(workflows).values({
        id,
        name: id,
        description: '',
        definition: snapshot,
        version: 1,
        schemaVersion: 4,
      })
      await scope.harness.db.insert(tasks).values({
        id,
        name: id,
        workflowId: id,
        workflowSnapshot: snapshot,
        repoPath: reference,
        worktreePath: reference,
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'done',
        inputs: '{}',
        startedAt: 1,
        executionLineageId: id,
        lineageSlotPathJson: JSON.stringify([
          { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
        ]),
      })
      expect(existsSync(reference)).toBe(false)
      const request = (suffix: string) =>
        app.request(`/api/tasks/${id}/${suffix}`, { headers: { Authorization: `Bearer ${token}` } })
      return { request, reference }
    }

    for (const operation of ['tree', 'file'] as const) {
      test(`HTTP ${operation} waits for the selected receiver and preserves the original display DTO`, async () => {
        const content = new SelectedContent(bytes)
        const f = await fixture(content)
        expect(Object.hasOwn(content, 'bind')).toBe(false)
        let settled = false
        const pending = Promise.resolve(
          f.request(operation === 'tree' ? 'worktree-tree' : 'worktree-file?path=selected.bin'),
        ).then((response) => {
          settled = true
          return response
        })
        await content.entered.promise
        expect(settled).toBe(false)
        expect(content.bindings).toEqual([f.reference])
        content.release.resolve()
        const response = await pending
        expect(response.status).toBe(200)
        if (operation === 'tree') {
          expect(worktreeTreeResponseSchema.parse(await response.json())).toEqual({
            path: '',
            entries: [{ name: 'selected.bin', kind: 'file', size: bytes.length }],
            truncated: false,
          })
        } else {
          expect(worktreeFileResponseSchema.parse(await response.json())).toEqual({
            path: 'selected.bin',
            size: bytes.length,
            oversized: false,
            content: new TextDecoder().decode(bytes),
          })
          expect(content.requests).toEqual([
            { relativeFile: 'selected.bin', offset: 0, maxBytes: 0 },
            { relativeFile: 'selected.bin', offset: 0, maxBytes: WORKTREE_FILE_MAX_BYTES },
          ])
          const missing = await f.request('worktree-file?path=missing.bin')
          expect(missing.status).toBe(404)
          expect(await missing.json()).toMatchObject({ code: 'worktree-file-not-found' })
        }
        expect(new Set(content.bindings)).toEqual(new Set([f.reference]))
      }, 25_000)
    }

    test('HTTP oversized display stops after selected metadata and never opens a native path', async () => {
      const content = new SelectedContent(Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 5, 91))
      const f = await fixture(content)
      content.release.resolve()
      const response = await f.request('worktree-file?path=selected.bin')
      expect(response.status).toBe(200)
      expect(worktreeFileResponseSchema.parse(await response.json())).toEqual({
        path: 'selected.bin',
        size: WORKTREE_FILE_MAX_BYTES + 5,
        oversized: true,
        content: '',
      })
      expect(content.requests).toEqual([{ relativeFile: 'selected.bin', offset: 0, maxBytes: 0 }])
    }, 25_000)
  },
)
