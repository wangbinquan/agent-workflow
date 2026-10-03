import { expect, test } from 'bun:test'
import { WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import { createWorkspaceContentScope } from '@/modules/source-control/composition'
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
import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'
import { NotFoundError } from '@/util/errors'

function held() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

class SelectedWorkspaceContent implements WorkspaceContentEffects {
  readonly #bytes: Buffer
  readonly #wait: Promise<void> | undefined
  readonly requests: Array<WorkspaceListRequest | WorkspaceReadRequest> = []

  constructor(bytes: Buffer, wait?: Promise<void>) {
    this.#bytes = bytes
    this.#wait = wait
    Object.freeze(this)
  }

  async list(request: WorkspaceListRequest): Promise<WorkspaceEntryPage> {
    this.requests.push(request)
    await this.#wait
    const names = ['first.bin', 'second.bin', 'third.bin']
    const end = Math.min(names.length, request.page.offset + request.maxEntries)
    return {
      entries: names.slice(request.page.offset, end).map((name) => ({
        name,
        kind: 'file' as const,
        size: this.#bytes.length,
      })),
      nextOffset: end < names.length ? end : null,
      truncated: false,
    }
  }

  async read(request: WorkspaceReadRequest): Promise<BoundedWorkspaceContent> {
    this.requests.push(request)
    await this.#wait
    if (request.relativeFile === 'missing')
      throw new NotFoundError('selected-workspace-file-missing', 'selected content missing')
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

class SelectedWorkspaceFactory implements WorkspaceContentEffectsFactory {
  readonly #content: WorkspaceContentEffects
  readonly bindings: string[] = []

  constructor(content: WorkspaceContentEffects) {
    this.#content = content
    Object.freeze(this)
  }

  bind(workspaceRef: string): WorkspaceContentEffects {
    this.bindings.push(workspaceRef)
    return this.#content
  }
}

test('selected prototype receivers carry opaque bindings and complete byte and entry pages', async () => {
  const bytes = Buffer.concat([Buffer.from('中😀'), Buffer.from([0, 255, 254, 128])])
  const content = new SelectedWorkspaceContent(bytes)
  const factory = new SelectedWorkspaceFactory(content)
  const queries = composeTaskWorkspaceQueries({
    load: async () => ({ worktreePath: 'logical:workspace:alpha' }),
    contentScope: (reference) => createWorkspaceContentScope(reference, factory),
  })
  const names: string[] = []
  let entryOffset: number | null = 0
  while (entryOffset !== null) {
    const page = await queries.list('task', {
      relativeDirectory: '',
      page: { offset: entryOffset },
      maxEntries: 2,
    })
    names.push(...page.entries.map((entry) => entry.name))
    entryOffset = page.nextOffset
  }
  expect(names).toEqual(['first.bin', 'second.bin', 'third.bin'])
  const pages: Buffer[] = []
  let byteOffset: number | null = 0
  while (byteOffset !== null) {
    const page = await queries.read('task', {
      relativeFile: 'first.bin',
      offset: byteOffset,
      maxBytes: 2,
    })
    pages.push(Buffer.from(page.content, 'base64'))
    byteOffset = page.nextOffset
  }
  expect(Buffer.concat(pages)).toEqual(bytes)
  expect((await queries.readDisplay('task', 'first.bin')).content).toBe(
    new TextDecoder().decode(bytes),
  )
  expect(factory.bindings.length).toBeGreaterThan(2)
  expect(new Set(factory.bindings)).toEqual(new Set(['logical:workspace:alpha']))
  await expect(
    queries.read('task', { relativeFile: 'missing', offset: 0, maxBytes: 1 }),
  ).rejects.toMatchObject({ code: 'selected-workspace-file-missing' })
})

test('selected zero-byte observations preserve the oversized display short circuit', async () => {
  const content = new SelectedWorkspaceContent(Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 1))
  const factory = new SelectedWorkspaceFactory(content)
  const queries = composeTaskWorkspaceQueries({
    load: async () => ({ worktreePath: 'logical:workspace:large' }),
    contentScope: (reference) => createWorkspaceContentScope(reference, factory),
  })
  expect(await queries.readDisplay('task', 'large.bin')).toEqual({
    size: WORKTREE_FILE_MAX_BYTES + 1,
    oversized: true,
    content: '',
  })
  expect(content.requests).toEqual([{ relativeFile: 'large.bin', offset: 0, maxBytes: 0 }])
})

for (const operation of ['list', 'read'] as const) {
  test(`scope closes while selected ${operation} waits for ACK`, async () => {
    const gate = held()
    const content = new SelectedWorkspaceContent(Buffer.from([0, 255]), gate.promise)
    const factory = new SelectedWorkspaceFactory(content)
    const scope = createWorkspaceContentScope('logical:workspace:held', factory)
    let settled = false
    const pending =
      operation === 'list'
        ? scope.participant.list(scope.snapshot, {
            relativeDirectory: '',
            page: { offset: 0 },
            maxEntries: 1,
          })
        : scope.participant.read(scope.snapshot, {
            relativeFile: 'first.bin',
            offset: 0,
            maxBytes: 1,
          })
    const completion = pending.then(
      () => {
        settled = true
        return null
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await Promise.resolve()
    expect(content.requests).toHaveLength(1)
    expect(settled).toBe(false)
    scope.close()
    gate.release()
    expect(await completion).toBeInstanceOf(Error)
    expect(String(await completion)).toContain('workspace-content-scope-ended-or-mismatched')
    expect(factory.bindings).toEqual(['logical:workspace:held'])
  })
}
