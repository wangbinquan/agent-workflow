// RFC-370: retain the original upload policy and native timing while selected content waits for ACKs.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyWorkspaceUploads } from '@/modules/task-execution/public/commands'
import { resolveUniqueUploadNameSync } from '@/modules/task-execution/public/queries'
import type { WorkspaceUploadPlan } from '@/modules/task-execution/public/types'
import { selectWorkspaceUploadContentFactory } from '@/modules/source-control/public/participants'
import type { WorkspaceUploadContentFactory } from '@/modules/source-control/public/types'
import { applyUploadsToWorktree, resolveUniqueName } from '@/services/upload'
import { applyUploadsToWorktree as nativeUpload } from '@/platform/content/local/workspaceUploads'
import { held, callablePromise } from './helpers/portArtifactContent'
import {
  MemoryWorkspaceUploadContent,
  MemoryWorkspaceUploadFactory,
} from './helpers/workspaceUploadContent'

function plan(overrides: Partial<WorkspaceUploadPlan> = {}): WorkspaceUploadPlan {
  return {
    workspace: { workspaceRef: 'opaque:workspace', generation: 'g4', version: 'v7' },
    defs: new Map([['refs', { key: 'refs', targetDir: 'inputs' }]]),
    files: [
      { inputKey: 'refs', filename: 'a.txt', declaredMime: 'text/plain', bytes: Uint8Array.of(65) },
    ],
    limits: { perFile: 2048, perRequest: 8192, perCount: 5 },
    ...overrides,
  }
}

test('a frozen prototype/private receiver binds once and waits for callable bind ACK', async () => {
  const entered = held<void>(),
    release = held<void>()
  const content = Object.freeze(new MemoryWorkspaceUploadContent())
  const factory = Object.freeze(
    new MemoryWorkspaceUploadFactory(content, () => {
      entered.resolve()
      return callablePromise(release.promise)
    }),
  )
  expect(selectWorkspaceUploadContentFactory(factory)).toBe(factory)
  expect(factory.bindings).toEqual([])
  expect(content.calls).toEqual([])
  const request = plan(),
    pending = applyWorkspaceUploads(request, factory)
  await entered.promise
  expect(factory.bindings).toEqual([request.workspace])
  expect(factory.bindings[0]).toBe(request.workspace)
  expect(content.calls).toEqual([])
  release.resolve()
  expect((await pending).packedByKey.get('refs')).toEqual(['inputs/a.txt'])
  expect(factory.bindings).toHaveLength(1)
  expect(content.entries.get(content.key('inputs', 'a.txt'))).toEqual({
    kind: 'file',
    bytes: Uint8Array.of(65),
  })
})

test('original validation fails before any selected bind or effect', async () => {
  const content = new MemoryWorkspaceUploadContent(),
    factory = new MemoryWorkspaceUploadFactory(content)
  for (const invalid of [
    plan({ limits: { perFile: 0, perRequest: 10, perCount: 5 } }),
    plan({ defs: new Map([['refs', { key: 'refs', targetDir: 'inputs', accept: ['.pdf'] }]]) }),
    plan({ files: [...plan().files, ...plan().files] }),
  ]) {
    await expect(applyWorkspaceUploads(invalid, factory)).rejects.toBeInstanceOf(Error)
  }
  expect(factory.bindings).toEqual([])
  expect(content.calls).toEqual([])
})

for (const boundary of ['prepare', 'file', 'write'] as const) {
  test('selected ' + boundary + ' ACK precedes batch completion', async () => {
    const entered = held<void>(),
      release = held<void>()
    let waiting = true,
      completed = false
    const content = Object.freeze(
      new MemoryWorkspaceUploadContent((method) => {
        if (method === boundary && waiting) {
          waiting = false
          entered.resolve()
          return callablePromise(release.promise)
        }
      }),
    )
    const pending = applyWorkspaceUploads(plan(), new MemoryWorkspaceUploadFactory(content)).then(
      (result) => {
        completed = true
        return result
      },
    )
    await entered.promise
    expect(completed).toBe(false)
    expect(content.entries.size).toBe(0)
    if (boundary === 'prepare') expect(content.calls).toEqual(['prepare:inputs'])
    if (boundary === 'file') expect(content.calls.some((x) => x.startsWith('entry:'))).toBe(false)
    release.resolve()
    expect((await pending).packedByKey.get('refs')).toEqual(['inputs/a.txt'])
    expect(completed).toBe(true)
  })
}

test('placement reserve ACK precedes the write, and a rejection keeps the original value', async () => {
  const entered = held<void>(),
    release = held<void>(),
    content = new MemoryWorkspaceUploadContent()
  const request = plan({
    recovery: {
      placement: () => null,
      async reserve(index, filename) {
        expect([index, filename]).toEqual([0, 'a.txt'])
        entered.resolve()
        await release.promise
      },
    },
  })
  const pending = applyWorkspaceUploads(request, new MemoryWorkspaceUploadFactory(content))
  await entered.promise
  expect(content.calls.some((x) => x.startsWith('write:'))).toBe(false)
  release.resolve()
  expect((await pending).packedByKey.get('refs')).toEqual(['inputs/a.txt'])
  const reason = Object.create(null),
    rejected = new MemoryWorkspaceUploadContent()
  await expect(
    applyWorkspaceUploads(
      plan({ recovery: { placement: () => null, reserve: () => Promise.reject(reason) } }),
      new MemoryWorkspaceUploadFactory(rejected),
    ),
  ).rejects.toBe(reason)
  expect(rejected.entries.size).toBe(0)
  expect(rejected.calls.some((x) => x.startsWith('write:'))).toBe(false)
})

test('rename, overwrite, root packing and multi-repository inputs retain the same policy', async () => {
  const content = new MemoryWorkspaceUploadContent(),
    factory = new MemoryWorkspaceUploadFactory(content)
  content.entries.set(content.key('inputs', 'a.txt'), { kind: 'other' })
  expect((await applyWorkspaceUploads(plan(), factory)).packedByKey.get('refs')).toEqual([
    'inputs/a (1).txt',
  ])
  expect(content.entries.get(content.key('inputs', 'a.txt'))?.kind).toBe('other')
  const overwrite = plan({
    defs: new Map([['refs', { key: 'refs', targetDir: 'inputs', onConflict: 'overwrite' }]]),
  })
  expect((await applyWorkspaceUploads(overwrite, factory)).packedByKey.get('refs')).toEqual([
    'inputs/a.txt',
  ])
  expect(content.entries.get(content.key('inputs', 'a.txt'))).toEqual({
    kind: 'file',
    bytes: Uint8Array.of(65),
  })
  expect(
    (
      await applyWorkspaceUploads(
        plan({ defs: new Map([['refs', { key: 'refs', targetDir: '.' }]]) }),
        factory,
      )
    ).packedByKey.get('refs'),
  ).toEqual(['a.txt'])
  expect(
    (
      await applyWorkspaceUploads(plan({ inputsSubdir: '.agent-workflow/inputs' }), factory)
    ).packedByKey.get('refs'),
  ).toEqual(['.agent-workflow/inputs/inputs/a.txt'])
  expect(
    (
      await applyWorkspaceUploads(
        plan({
          inputsSubdir: '.agent-workflow/inputs',
          defs: new Map([['refs', { key: 'refs', targetDir: '.agent-workflow/refs' }]]),
        }),
        factory,
      )
    ).packedByKey.get('refs'),
  ).toEqual(['.agent-workflow/refs/a.txt'])
  content.entries.set(content.key('inputs', 'a.txt'), { kind: 'directory' })
  await expect(applyWorkspaceUploads(overwrite, factory)).rejects.toMatchObject({
    code: 'upload-target-is-dir',
  })
  expect(content.entries.get(content.key('inputs', 'a.txt'))?.kind).toBe('directory')
})

test('restored placement waits for a full-byte read, reuses its name, and never reserves or writes', async () => {
  const entered = held<void>(),
    release = held<void>(),
    bytes = new Uint8Array(2048).fill(23)
  const content = new MemoryWorkspaceUploadContent((method) => {
    if (method === 'read') {
      entered.resolve()
      return release.promise
    }
  })
  content.entries.set(content.key('inputs', 'a.txt'), { kind: 'file', bytes })
  let completed = false
  const pending = applyWorkspaceUploads(
    plan({
      files: [{ ...plan().files[0]!, bytes }],
      recovery: {
        placement: () => 'a.txt',
        reserve: async () => {
          throw new Error('must not reserve')
        },
      },
    }),
    new MemoryWorkspaceUploadFactory(content),
  ).then((result) => {
    completed = true
    return result
  })
  await entered.promise
  expect(completed).toBe(false)
  release.resolve()
  expect((await pending).packedByKey.get('refs')).toEqual(['inputs/a.txt'])
  expect(content.calls.some((x) => x.startsWith('write:') || x.startsWith('remove:'))).toBe(false)
  const changed = bytes.slice()
  changed[changed.length - 1] = 24
  content.entries.set(content.key('inputs', 'a.txt'), { kind: 'file', bytes: changed })
  await expect(
    applyWorkspaceUploads(
      plan({
        files: [{ ...plan().files[0]!, bytes }],
        recovery: { placement: () => 'a.txt', reserve: async () => {} },
      }),
      new MemoryWorkspaceUploadFactory(content),
    ),
  ).rejects.toMatchObject({ code: 'upload-replay-changed' })
})

test('restored non-files reject before read and missing placements write without another reserve', async () => {
  const request = plan({
    recovery: {
      placement: () => 'saved.txt',
      reserve: async () => {
        throw new Error('unexpected reserve')
      },
    },
  })
  for (const kind of ['directory', 'other'] as const) {
    const content = new MemoryWorkspaceUploadContent()
    content.entries.set(content.key('inputs', 'saved.txt'), { kind })
    await expect(
      applyWorkspaceUploads(request, new MemoryWorkspaceUploadFactory(content)),
    ).rejects.toMatchObject({ code: 'upload-replay-changed' })
    expect(content.calls.some((x) => x.startsWith('read:') || x.startsWith('write:'))).toBe(false)
  }
  const content = new MemoryWorkspaceUploadContent()
  expect(
    (
      await applyWorkspaceUploads(request, new MemoryWorkspaceUploadFactory(content))
    ).packedByKey.get('refs'),
  ).toEqual(['inputs/saved.txt'])
})

test('rollback waits in original write order, attempts every removal, and preserves the first rejection', async () => {
  const entered = held<void>(),
    release = held<void>(),
    reason = Object.create(null)
  const content = new MemoryWorkspaceUploadContent((method, reference) => {
    if (method === 'write' && reference === content.key('inputs', 'c.txt'))
      return Promise.reject(reason)
    if (method === 'remove' && reference === content.key('inputs', 'a.txt')) {
      entered.resolve()
      return release.promise
    }
    if (method === 'remove') return Promise.reject(new Error('secondary cleanup failure'))
  })
  const pending = applyWorkspaceUploads(
    plan({
      files: ['a.txt', 'b.txt', 'c.txt'].map((filename) => ({ ...plan().files[0]!, filename })),
    }),
    new MemoryWorkspaceUploadFactory(content),
  )
  const outcome = pending.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  )
  await entered.promise
  expect(content.calls.filter((x) => x.startsWith('remove:'))).toEqual([
    'remove:' + content.key('inputs', 'a.txt'),
  ])
  release.resolve()
  expect(await outcome).toEqual({ ok: false, error: reason })
  expect(content.calls.filter((x) => x.startsWith('remove:'))).toEqual(
    ['a.txt', 'b.txt'].map((x) => 'remove:' + content.key('inputs', x)),
  )
  expect(content.entries.has(content.key('inputs', 'a.txt'))).toBe(false)
  expect(content.entries.has(content.key('inputs', 'b.txt'))).toBe(true)
})

test('explicit null/incomplete selections and incomplete bound receivers never select native content', async () => {
  for (const value of [null, {}]) {
    await expect(
      applyWorkspaceUploads(plan(), value as unknown as WorkspaceUploadContentFactory),
    ).rejects.toThrow('complete content factory')
  }
  const factory = {
    bind: () => ({
      prepareTarget() {
        throw new Error('must not call')
      },
    }),
  } as unknown as WorkspaceUploadContentFactory
  await expect(applyWorkspaceUploads(plan(), factory)).rejects.toThrow('complete content receiver')
})

test('the shared name policy preserves original probing and the 999-candidate bound', () => {
  const calls: string[] = []
  expect(
    resolveUniqueUploadNameSync('report.pdf', (name) => {
      calls.push(name)
      return calls.length < 3
    }),
  ).toBe('report (2).pdf')
  expect(calls).toEqual(['report.pdf', 'report (1).pdf', 'report (2).pdf'])
  let count = 0
  expect(() =>
    resolveUniqueUploadNameSync('a.txt', () => {
      count++
      return true
    }),
  ).toThrow('after 999 attempts')
  expect(count).toBe(1000)
})

test('legacy native calls keep synchronous batch timing, helper identity and the same mutable Map API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-upload-native-'))
  try {
    const absent = join(root, 'absent')
    expect(resolveUniqueName(absent, 'a.txt')).toBe('a.txt')
    expect(existsSync(absent)).toBe(false)
    expect(applyUploadsToWorktree).toBe(nativeUpload)
    const request = plan(),
      nativePlan = {
        worktreePath: root,
        defs: request.defs,
        files: request.files,
        limits: request.limits,
      }
    const first = applyUploadsToWorktree(nativePlan),
      second = applyUploadsToWorktree(nativePlan)
    // Before either returned promise is awaited, the original synchronous batches already landed.
    expect(readFileSync(join(root, 'inputs', 'a.txt'))).toEqual(Buffer.from([65]))
    expect(readFileSync(join(root, 'inputs', 'a (1).txt'))).toEqual(Buffer.from([65]))
    const result = await first,
      other = await second,
      sameMap = result.packedByKey
    expect(sameMap.get('refs')).toEqual(['inputs/a.txt'])
    expect(other.packedByKey.get('refs')).toEqual(['inputs/a (1).txt'])
    sameMap.set('extra', ['one'])
    sameMap.get('extra')!.push('two')
    expect(result.packedByKey).toBe(sameMap)
    expect(result.packedByKey.get('extra')).toEqual(['one', 'two'])
    expect(sameMap.delete('extra')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
