import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKTREE_DIR_MAX_ENTRIES, WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import { createWorkspaceContentScope } from '@/modules/source-control/infrastructure/workspaceContent'
import { composeTaskWorkspaceQueries } from '@/modules/task-execution/composition'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rfc363-reader-'))
  roots.push(root)
  const queries = composeTaskWorkspaceQueries({
    load: async (id) => (id === 'missing' ? null : { worktreePath: id === 'empty' ? '' : root }),
    contentScope: createWorkspaceContentScope,
  })
  return { root, queries }
}

test('full sorted paging reaches entries beyond the old display cap', async () => {
  const { root, queries } = await fixture()
  await mkdir(join(root, 'directory'))
  await mkdir(join(root, '.git'))
  const names = Array.from(
    { length: WORKTREE_DIR_MAX_ENTRIES + 3 },
    (_, i) => `f${String(i).padStart(5, '0')}`,
  )
  await Promise.all(names.map((name) => writeFile(join(root, name), name)))
  const all: string[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = await queries.list('task', {
      relativeDirectory: '',
      page: { offset },
      maxEntries: 137,
    })
    expect(page.truncated).toBe(false)
    all.push(...page.entries.map((entry) => entry.name))
    if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
  expect(all).toEqual(['directory', ...names])
  const display = await queries.listDisplay('task', '')
  expect(display.entries).toHaveLength(WORKTREE_DIR_MAX_ENTRIES)
  expect(display.truncated).toBe(true)
})

test('byte pages preserve split UTF-8 sequences and binary data; display keeps replacement decoding', async () => {
  const { root, queries } = await fixture()
  const bytes = Buffer.concat([Buffer.from('中😀'), Buffer.from([0, 255, 254, 128])])
  await writeFile(join(root, 'bytes.bin'), bytes)
  const chunks: Buffer[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = await queries.read('task', { relativeFile: 'bytes.bin', offset, maxBytes: 2 })
    expect(page.offset).toBe(offset)
    expect(page.size).toBe(bytes.length)
    chunks.push(Buffer.from(page.content, 'base64'))
    offset = page.nextOffset
  }
  expect(Buffer.concat(chunks)).toEqual(bytes)
  expect((await queries.readDisplay('task', 'bytes.bin')).content).toBe(
    new TextDecoder().decode(bytes),
  )
  expect(
    await queries.read('task', { relativeFile: 'bytes.bin', offset: 99, maxBytes: 2 }),
  ).toMatchObject({ content: '', nextOffset: null, offset: 99 })
})

test('large content stays pageable while the existing HTTP projection remains empty', async () => {
  const { root, queries } = await fixture()
  const bytes = Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 5, 91)
  await writeFile(join(root, 'large.bin'), bytes)
  expect(
    await queries.read('task', { relativeFile: 'large.bin', offset: 0, maxBytes: 0 }),
  ).toMatchObject({ content: '', size: bytes.length, nextOffset: 0, oversized: true })
  const page = await queries.read('task', {
    relativeFile: 'large.bin',
    offset: WORKTREE_FILE_MAX_BYTES,
    maxBytes: 3,
  })
  expect(page).toMatchObject({
    content: Buffer.from([91, 91, 91]).toString('base64'),
    nextOffset: WORKTREE_FILE_MAX_BYTES + 3,
    oversized: true,
  })
  expect(await queries.readDisplay('task', 'large.bin')).toEqual({
    size: bytes.length,
    oversized: true,
    content: '',
  })
})

test('scopes do not cross bindings or outlive a query and reclaimed workspaces keep the old errors', async () => {
  const { root, queries } = await fixture()
  const first = createWorkspaceContentScope(root)
  const other = createWorkspaceContentScope(root)
  const request = { relativeDirectory: '', page: { offset: 0 }, maxEntries: 1 }
  await expect(first.participant.list(other.snapshot, request)).rejects.toThrow(
    'workspace-content-scope-ended-or-mismatched',
  )
  first.close()
  await expect(first.participant.list(first.snapshot, request)).rejects.toThrow(
    'workspace-content-scope-ended-or-mismatched',
  )
  other.close()
  await expect(queries.list('missing', request)).rejects.toMatchObject({ code: 'task-not-found' })
  await expect(queries.list('empty', request)).rejects.toMatchObject({
    code: 'task-worktree-missing',
  })
  await expect(queries.list('task', { ...request, page: { offset: -1 } })).rejects.toMatchObject({
    code: 'workspace-read-bounds-invalid',
  })
  await rm(root, { recursive: true })
  await expect(queries.list('task', request)).rejects.toMatchObject({
    code: 'worktree-dir-not-found',
  })
})
