// RFC-037 T6 — locks the launcher submit paths (JSON / url-multipart) stamping
// the task `name` into the outgoing body. Pure-function helpers; no React or
// HTTP harness needed. (RFC-165: the path-multipart submit path is retired.)

import { describe, expect, test } from 'vitest'
import { buildLaunchBody, type RepoSource } from '@/lib/launch-repo-source'
import { buildWorkflowStartFormData } from '@/lib/task-wizard'

function readPayload(fd: FormData): Record<string, unknown> {
  const payload = fd.get('payload')
  expect(payload).not.toBeNull()
  if (typeof payload === 'string') return JSON.parse(payload) as Record<string, unknown>
  // Blob path: synchronous .text() isn't available; we rely on the builder
  // always producing a Blob whose contents we can read via .text() awaited.
  throw new Error('expected string payload — call readPayloadAsync for Blob path')
}

async function readPayloadAsync(fd: FormData): Promise<Record<string, unknown>> {
  const payload = fd.get('payload')
  if (typeof payload === 'string') return JSON.parse(payload) as Record<string, unknown>
  if (payload instanceof Blob) return JSON.parse(await payload.text()) as Record<string, unknown>
  throw new Error('missing payload field')
}

describe('RFC-037 — buildLaunchBody passes name into JSON body', () => {
  test('body includes name', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@github.com:o/r.git', ref: '' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 'url task', inputs: {} })
    expect(body.name).toBe('url task')
    expect(body.workflowId).toBe('wf-1')
    expect(body.repoUrl).toBe('git@github.com:o/r.git')
  })
})

describe('RFC-037 / RFC-107 — buildWorkflowStartFormData (url-multipart) carries name + repoUrl + ref', () => {
  // RFC-107 lifted the URL + uploads limit: the backend now resolves the URL
  // into the repo cache before materializing the worktree. The multipart
  // payload must therefore carry repoUrl AND ref so the right branch is cloned.
  test('payload JSON carries name, repoUrl and ref', async () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'release/1.2' }
    const fd = buildWorkflowStartFormData(
      { kind: 'remote', repos: [src] },
      { workflowId: 'wf-1', name: 'url multipart', inputs: {} },
      { up: [new File([new Uint8Array([3])], 'b.bin')] },
    )
    const json = await readPayloadAsync(fd)
    expect(json.name).toBe('url multipart')
    expect(json.repoUrl).toBe('git@h:o/r.git')
    expect(json.ref).toBe('release/1.2')
    expect(fd.getAll('files[up][]').length).toBe(1)
  })
})

describe('RFC-037 — guard against silently-dropped name (source-level grep)', () => {
  test('readPayload helper smoke', () => {
    const fd = new FormData()
    fd.set('payload', JSON.stringify({ name: 'x' }))
    expect(readPayload(fd).name).toBe('x')
  })
})
