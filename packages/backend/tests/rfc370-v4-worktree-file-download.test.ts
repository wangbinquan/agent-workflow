// RFC-370 §10 V15 — worktree file downloads read through Source Control's
// workspace content.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). `GET
// /api/worktree-files/:taskId/*` (files-page download, the port-artifact
// download fallback, images in review markdown) read the task's worktree with
// local `fs` calls, so every hosted task — whose worktree is a `cs-workspace:`
// volume reference — answered 404. The route now streams bounded pages from
// the selected content; the hosted content answers a missing file with the
// same not-found code as a standalone worktree.
import { expect, test } from 'bun:test'
import { Hono, type Context } from 'hono'
import { buildActor } from '@/auth/actor'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
import { createHostedWorkspaceEffects } from '@/modules/source-control/infrastructure/crewstation/workspaceEffects'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { CrewStationApiError } from '@/platform/crewstation/platformApi'
import type {
  BoundedWorkspaceContent,
  WorkspaceReadRequest,
} from '@/modules/source-control/public/types'
import { errorHandler, NotFoundError } from '@/util/errors'

const TASK = '01M599DJXA50YPXWZR5TNNG2BW'
const WORKTREE = `cs-workspace:${TASK}/worktrees/${TASK}`

function appWith(
  content: (ref: string) => { read(r: WorkspaceReadRequest): Promise<BoundedWorkspaceContent> },
) {
  const app = new Hono()
  const actor = buildActor({
    user: {
      id: 'viewer',
      username: 'viewer',
      displayName: 'Viewer',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
  app.use('*', async (c: Context, next) => {
    c.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  mountWorktreeFilesRoutes(app, {
    locator: {
      find: async (id: string) =>
        id === TASK
          ? ({ taskId: id, worktreePath: WORKTREE, ownerUserId: 'viewer' } as never)
          : null,
    } as never,
    canViewTask: async () => true,
    content,
  })
  return app
}

test('a hosted task volume file is streamed page by page with its type and length', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
  const reads: { ref: string; request: WorkspaceReadRequest }[] = []
  const app = appWith((ref) => ({
    async read(request) {
      reads.push({ ref, request })
      const end = Math.min(bytes.length, request.offset + 3)
      return {
        encoding: 'base64',
        content: Buffer.from(bytes.subarray(request.offset, end)).toString('base64'),
        size: bytes.length,
        offset: request.offset,
        nextOffset: end < bytes.length ? end : null,
        oversized: false,
      }
    },
  }))
  const response = await app.request(`/api/worktree-files/${TASK}/img/diagram.png`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(response.headers.get('content-length')).toBe(String(bytes.length))
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(reads.map((read) => [read.ref, read.request.relativeFile, read.request.offset])).toEqual([
    [WORKTREE, 'img/diagram.png', 0],
    [WORKTREE, 'img/diagram.png', 3],
    [WORKTREE, 'img/diagram.png', 6],
  ])
})

test('a missing file is a not-found answer, and an escaping path never reaches the content', async () => {
  let reads = 0
  const app = appWith(() => ({
    async read() {
      reads += 1
      throw new NotFoundError('worktree-file-not-found', "file 'NOTES.md' not found")
    },
  }))
  const missing = await app.request(`/api/worktree-files/${TASK}/NOTES.md`)
  expect(missing.status).toBe(404)
  expect(await missing.json()).toMatchObject({ code: 'worktree-file-not-found' })
  const escape = await app.request(`/api/worktree-files/${TASK}/..%2F..%2Fsecret.txt`)
  expect(escape.status).toBe(422)
  expect(await escape.json()).toMatchObject({ code: 'worktree-file-escapes-worktree' })
  // The un-suffixed route stays a guidance 4xx, not Hono's default 404.
  const bare = await app.request(`/api/worktree-files/${TASK}`)
  expect(bare.status).toBe(422)
  expect(await bare.json()).toMatchObject({ code: 'worktree-file-missing-path' })
  expect(reads).toBe(1)
})

test('a file that changes between pages fails the stream instead of mixing versions', async () => {
  let reads = 0
  const app = appWith(() => ({
    async read(request) {
      reads += 1
      // The second page sees a different file size: the file changed mid-read.
      const size = reads === 1 ? 6 : 9
      return {
        encoding: 'base64',
        content: Buffer.from('abc').toString('base64'),
        size,
        offset: request.offset,
        nextOffset: request.offset + 3,
        oversized: false,
      }
    },
  }))
  const response = await app.request(`/api/worktree-files/${TASK}/NOTES.md`)
  expect(response.status).toBe(200)
  await expect(response.arrayBuffer()).rejects.toThrow('worktree-file-changed-during-read')
})

const unused = async (): Promise<never> => {
  throw new Error('unexpected platform operation')
}

test('the hosted workspace content answers a file the platform does not have with not-found', async () => {
  const effects = createHostedWorkspaceEffects({
    helper: { call: unused } as never,
    workspaces: { open: async () => ({ businessTaskId: 'cs-parent' }) as never },
    api: {
      readFile: async () => {
        throw new CrewStationApiError(404, 'not_found', 'file not found', {})
      },
    } as unknown as CrewStationBusinessExecution,
  })
  const read = effects.workspaceContent
    .bind(WORKTREE)
    .read({ relativeFile: 'NOTES.md', offset: 0, maxBytes: 1024 })
  await expect(read).rejects.toMatchObject({ code: 'worktree-file-not-found' })
})
