import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '../src'
import { runChecked } from '../src/core/process'

let suite: StartedSystemMockSuite
const temporaryPaths: string[] = []

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterAll(async () => {
  await suite.close()
  await Promise.all(
    temporaryPaths.map(async (path) => await rm(path, { recursive: true, force: true })),
  )
})

describe('RFC-304 code-host state', () => {
  test('GitLab exposes real diff refs and preserves draft, published discussion and CI state', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath: 'review/gitlab-project',
      baseFiles: {
        'README.md': 'base\n',
        'src/change.ts': 'export const value = 1\n',
        'src/delete.ts': 'delete me\n',
      },
      headFiles: {
        'README.md': 'head\n',
        'src/change.ts': 'export const value = 2\n',
        'src/delete.ts': null,
        'src/generated.ts': 'generated\n',
      },
      diffOmissions: { 'src/generated.ts': 'too-large' },
      issues: [{ number: 23, title: 'Clarify the requirement' }],
      pipelines: [
        {
          id: 701,
          state: 'failed',
          jobs: [{ id: 801, name: 'compile', state: 'failed', log: 'TS2345\n' }],
        },
      ],
    })
    const root = `/projects/${encodeURIComponent(project.projectPath)}`

    const mr = await apiJson<{
      diff_refs: { base_sha: string; start_sha: string; head_sha: string }
    }>('gitlab', `${root}/merge_requests/1`)
    expect(mr.diff_refs).toEqual({
      base_sha: project.baseSha,
      start_sha: project.baseSha,
      head_sha: project.headSha,
    })

    const diffs = await apiJson<
      Array<{
        old_path: string
        new_path: string
        new_file: boolean
        deleted_file: boolean
        diff: string
      }>
    >('gitlab', `${root}/merge_requests/1/diffs`)
    expect(diffs.map((entry) => entry.new_path).sort()).toEqual([
      'README.md',
      'src/change.ts',
      'src/delete.ts',
      'src/generated.ts',
    ])
    expect(diffs.find((entry) => entry.new_path === 'src/delete.ts')?.deleted_file).toBe(true)
    expect(diffs.find((entry) => entry.new_path === 'src/generated.ts')?.diff).toBe('')
    expect(diffs.find((entry) => entry.new_path === 'src/change.ts')?.diff).toContain(
      '+export const value = 2',
    )

    const position = {
      position_type: 'text',
      base_sha: project.baseSha,
      start_sha: project.baseSha,
      head_sha: project.headSha,
      new_path: 'src/change.ts',
      new_line: 1,
    }
    const draft = await apiJson<{ id: number; note: string }>(
      'gitlab',
      `${root}/merge_requests/1/draft_notes`,
      { method: 'POST', body: { note: '<!-- aw-finding:one --> finding', position } },
    )
    const discarded = await apiJson<{ id: number }>(
      'gitlab',
      `${root}/merge_requests/1/draft_notes`,
      { method: 'POST', body: { note: 'discard me', position } },
    )
    expect(
      await apiResponse('gitlab', `${root}/merge_requests/1/draft_notes/${String(discarded.id)}`, {
        method: 'DELETE',
      }),
    ).toMatchObject({ status: 204 })
    expect(
      await apiJson<Array<{ id: number }>>('gitlab', `${root}/merge_requests/1/draft_notes`),
    ).toHaveLength(1)

    await apiJson('gitlab', `${root}/merge_requests/1/draft_notes/bulk_publish`, {
      method: 'POST',
      body: {},
    })
    const discussions = await apiJson<
      Array<{ id: string; notes: Array<{ id: number; body: string }> }>
    >('gitlab', `${root}/merge_requests/1/discussions`)
    expect(discussions).toHaveLength(1)
    expect(discussions[0]?.id).not.toBe(String(draft.id))
    expect(discussions[0]?.notes[0]?.body).toContain('aw-finding:one')

    const threadId = discussions[0]!.id
    const noteId = discussions[0]!.notes[0]!.id
    const resolved = await apiJson<{ notes: Array<{ resolved: boolean }> }>(
      'gitlab',
      `${root}/merge_requests/1/discussions/${encodeURIComponent(threadId)}`,
      { method: 'PUT', body: { resolved: true } },
    )
    expect(resolved.notes.every((note) => note.resolved)).toBe(true)
    const updated = await apiJson<{ body: string }>(
      'gitlab',
      `${root}/merge_requests/1/notes/${String(noteId)}`,
      { method: 'PUT', body: { body: '<!-- aw-finding:one --> updated' } },
    )
    expect(updated.body).toEndWith('updated')

    const issueComment = await apiJson<{ body: string }>('gitlab', `${root}/issues/23/notes`, {
      method: 'POST',
      body: { body: '<!-- aw-requirement --> need an answer' },
    })
    expect(issueComment.body).toContain('aw-requirement')
    const jobs = await apiJson<Array<{ id: number; name: string; status: string }>>(
      'gitlab',
      `${root}/pipelines/701/jobs`,
    )
    expect(jobs).toEqual([{ id: 801, name: 'compile', status: 'failed' }])
    expect(await (await apiResponse('gitlab', `${root}/jobs/801/trace`)).text()).toBe('TS2345\n')

    const snapshot = await suite.client.snapshot()
    const stored = snapshot.codeHosts[0]!
    expect(stored.mergeRequests[0]?.drafts).toHaveLength(0)
    expect(stored.mergeRequests[0]?.reviewComments[0]).toMatchObject({
      body: '<!-- aw-finding:one --> updated',
      resolved: true,
    })
    expect(stored.issues[0]?.comments[0]?.body).toContain('aw-requirement')
  })

  test('GitHub atomically publishes reviews and reads back review, overview, issue and CI state', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'github',
      projectPath: 'review/github-project',
      baseFiles: { 'src/a.ts': 'export const a = 1\n' },
      headFiles: { 'src/a.ts': 'export const a = 2\n' },
      issues: [{ number: 23, title: 'Need a specification' }],
      pipelines: [
        {
          id: 702,
          runId: '702',
          state: 'failed',
          jobs: [{ id: 802, name: 'test', state: 'failed', log: 'expect(received)\n' }],
        },
      ],
    })
    const root = `/repos/${project.projectPath}`

    await apiJson('github', `${root}/pulls/1/reviews`, {
      method: 'POST',
      body: {
        body: '<!-- aw-review-overview:round-1 --> Reviewed one finding',
        event: 'COMMENT',
        commit_id: project.headSha,
        comments: [
          {
            body: '<!-- aw-finding:one --> finding',
            path: 'src/a.ts',
            line: 1,
            side: 'RIGHT',
          },
        ],
      },
    })
    const reviewComments = await apiJson<
      Array<{ id: number; body: string; commit_id: string; path: string }>
    >('github', `${root}/pulls/1/comments`)
    expect(reviewComments).toHaveLength(1)
    expect(reviewComments[0]).toMatchObject({
      body: '<!-- aw-finding:one --> finding',
      commit_id: project.headSha,
      path: 'src/a.ts',
    })

    const reply = await apiJson<{ in_reply_to_id: number; body: string }>(
      'github',
      `${root}/pulls/1/comments/${String(reviewComments[0]!.id)}/replies`,
      { method: 'POST', body: { body: 'fixed in the next push' } },
    )
    expect(reply.in_reply_to_id).toBe(reviewComments[0]!.id)

    const overview = await apiJson<{ id: number; body: string }>(
      'github',
      `${root}/issues/1/comments`,
      { method: 'POST', body: { body: '<!-- aw-review-overview:round-1 --> overview' } },
    )
    const updated = await apiJson<{ body: string }>(
      'github',
      `${root}/issues/comments/${String(overview.id)}`,
      { method: 'PATCH', body: { body: '<!-- aw-review-overview:round-1 --> reconciled' } },
    )
    expect(updated.body).toEndWith('reconciled')
    const overviewList = await apiJson<Array<{ body: string }>>(
      'github',
      `${root}/issues/1/comments`,
    )
    expect(overviewList[0]?.body).toEndWith('reconciled')

    await apiJson('github', `${root}/issues/23/labels`, {
      method: 'POST',
      body: { labels: ['agent-workflow'] },
    })
    await apiJson('github', `${root}/issues/23/comments`, {
      method: 'POST',
      body: { body: '<!-- aw-requirement --> please clarify' },
    })
    expect(await apiJson('github', `${root}/issues/23`)).toMatchObject({
      labels: [{ name: 'agent-workflow' }],
    })

    const jobs = await apiJson<{
      total_count: number
      jobs: Array<{ id: number; conclusion: string }>
    }>('github', `${root}/actions/runs/702/jobs`)
    expect(jobs).toMatchObject({ total_count: 1, jobs: [{ id: 802, conclusion: 'failure' }] })
    const redirect = await apiResponse('github', `${root}/actions/jobs/802/logs`, {
      redirect: 'manual',
    })
    expect(redirect.status).toBe(302)
    const log = await fetch(redirect.headers.get('location')!)
    expect(await log.text()).toBe('expect(received)\n')

    const raw = await apiResponse('github', `${root}/contents/src%2Fa.ts?ref=${project.headSha}`, {
      headers: { accept: 'application/vnd.github.raw' },
    })
    expect(await raw.text()).toBe('export const a = 2\n')
  })

  test('a real Git push advances REST state and the provider special ref', async () => {
    const project = await suite.client.seedCodeHost({
      provider: 'github',
      projectPath: 'push/state-sync',
      baseFiles: { 'README.md': 'base\n' },
      headFiles: { 'README.md': 'head one\n' },
    })
    const clone = await temporaryDirectory('system-mock-push-')
    await runChecked('git', [
      'clone',
      '-q',
      '--branch',
      project.headBranch,
      project.repoHttpUrl,
      clone,
    ])
    await runChecked('git', ['config', 'user.email', 'push@mock.test'], { cwd: clone })
    await runChecked('git', ['config', 'user.name', 'Push Test'], { cwd: clone })
    await writeFile(join(clone, 'README.md'), 'head two\n')
    await writeFile(join(clone, 'after-push.ts'), 'export const pushed = true\n')
    await runChecked('git', ['add', '-A'], { cwd: clone })
    await runChecked('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'advance'], {
      cwd: clone,
    })
    const pushedSha = await runChecked('git', ['rev-parse', 'HEAD'], { cwd: clone })
    await runChecked('git', ['push', '-q', 'origin', `HEAD:refs/heads/${project.headBranch}`], {
      cwd: clone,
    })

    const pr = await apiJson<{ head: { sha: string } }>(
      'github',
      `/repos/${project.projectPath}/pulls/1`,
    )
    expect(pr.head.sha).toBe(pushedSha)
    const refs = await runChecked('git', ['ls-remote', project.repoHttpUrl, 'refs/pull/1/head'])
    expect(refs).toStartWith(`${pushedSha}\trefs/pull/1/head`)
    const diffs = await apiJson<Array<{ filename: string; patch?: string }>>(
      'github',
      `/repos/${project.projectPath}/pulls/1/files`,
    )
    expect(diffs.find((entry) => entry.filename === 'after-push.ts')?.patch).toContain(
      '+export const pushed = true',
    )
    expect(await readFile(join(clone, 'README.md'), 'utf8')).toBe('head two\n')
  })

  test('fork pull requests import the source commit into a fetchable target special ref', async () => {
    const source = await suite.client.seedCodeHost({
      provider: 'github',
      projectPath: 'forker/repo',
      headFiles: { 'README.md': 'from fork\n' },
    })
    const target = await suite.client.seedCodeHost({
      provider: 'github',
      projectPath: 'upstream/repo',
      headFiles: { 'README.md': 'upstream work\n' },
    })
    const created = await apiJson<{ number: number; head: { sha: string; label: string } }>(
      'github',
      `/repos/${target.projectPath}/pulls`,
      {
        method: 'POST',
        body: {
          title: 'fork change',
          head: `forker:${source.headBranch}`,
          base: target.defaultBranch,
        },
      },
    )
    expect(created).toMatchObject({
      number: 2,
      head: { sha: source.headSha, label: `forker/repo:${source.headBranch}` },
    })
    const refs = await runChecked('git', ['ls-remote', target.repoHttpUrl, 'refs/pull/2/head'])
    expect(refs).toStartWith(`${source.headSha}\trefs/pull/2/head`)
  })
})

describe('RFC-304 ingress and adapter boundaries', () => {
  test('delivers provider-shaped, signed issue-label and issue-comment webhooks', async () => {
    const captures: Array<{
      headers: Record<string, string | string[] | undefined>
      body: string
    }> = []
    const callback = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        captures.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"accepted":true}')
      })()
    })
    await new Promise<void>((resolve, reject) => {
      callback.once('error', reject)
      callback.listen(0, '127.0.0.1', resolve)
    })
    const address = callback.address()
    if (address === null || typeof address === 'string')
      throw new Error('unexpected callback address')
    const callbackUrl = `http://127.0.0.1:${String(address.port)}/webhook`
    const secret = 'rfc304-system-mock-secret'
    try {
      for (const provider of ['gitlab', 'github'] as const) {
        const projectPath = `ingress/${provider}`
        await suite.client.seedCodeHost({
          provider,
          projectPath,
          issues: [{ number: 41, title: 'Build this capability' }],
        })
        await suite.client.deliverWebhook({
          provider,
          callbackUrl,
          secret,
          projectPath,
          number: 41,
          event: 'issue_labeled',
          label: 'agent-workflow',
        })
        await suite.client.deliverWebhook({
          provider,
          callbackUrl,
          secret,
          projectPath,
          number: 41,
          event: 'issue_comment',
          body: 'The acceptance criterion is explicit.',
        })
      }
    } finally {
      await new Promise<void>((resolve) => callback.close(() => resolve()))
    }

    expect(captures).toHaveLength(4)
    const gitlabLabel = captures[0]!
    expect(gitlabLabel.headers['x-gitlab-event']).toBe('Issue Hook')
    expect(JSON.parse(gitlabLabel.body)).toMatchObject({
      object_kind: 'issue',
      object_attributes: { iid: 41, action: 'update' },
    })
    const gitlabComment = captures[1]!
    expect(gitlabComment.headers['x-gitlab-event']).toBe('Note Hook')
    expect(JSON.parse(gitlabComment.body)).toMatchObject({
      object_kind: 'note',
      issue: { iid: 41 },
      object_attributes: { noteable_type: 'Issue' },
    })
    const githubLabel = captures[2]!
    expect(githubLabel.headers['x-github-event']).toBe('issues')
    expect(JSON.parse(githubLabel.body)).toMatchObject({
      action: 'labeled',
      issue: { number: 41 },
      label: { name: 'agent-workflow' },
    })
    const githubComment = captures[3]!
    expect(githubComment.headers['x-github-event']).toBe('issue_comment')
    expect(JSON.parse(githubComment.body)).toMatchObject({
      action: 'created',
      issue: { number: 41 },
      comment: { body: 'The acceptance criterion is explicit.' },
    })
    const signature = String(githubComment.headers['x-hub-signature-256'])
    expect(signature).toBe(
      `sha256=${createHmac('sha256', secret).update(githubComment.body).digest('hex')}`,
    )
  })

  test('serves ordered generic HTTP responses for custom CI, issue and document adapters', async () => {
    await suite.client.seedHttpRoute({
      id: 'pipeline-status',
      method: 'GET',
      path: '/pipelines/41823',
      repeatLast: false,
      responses: [
        { status: 503, body: 'temporarily unavailable' },
        { status: 200, json: { state: 'failed', jobs: [{ id: 'compile' }] } },
      ],
    })
    const url = `${suite.endpoints.externalHttpBaseUrl}/pipelines/41823`
    expect(await (await fetch(url)).text()).toBe('temporarily unavailable')
    expect(await (await fetch(url)).json()).toEqual({
      state: 'failed',
      jobs: [{ id: 'compile' }],
    })
    expect((await fetch(url)).status).toBe(410)
    expect((await suite.client.snapshot()).externalHttp).toEqual([
      expect.objectContaining({ id: 'pipeline-status', consumed: 2 }),
    ])
    expect(await suite.client.requests('external')).toHaveLength(3)
    await suite.client.clearHttpRoutes()
    expect((await suite.client.snapshot()).externalHttp).toEqual([])
  })
})

async function apiResponse(
  provider: 'gitlab' | 'github',
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<Response> {
  const base =
    provider === 'gitlab' ? suite.endpoints.gitlabApiBaseUrl : suite.endpoints.githubApiBaseUrl
  const { body, ...requestInit } = init
  const headers = new Headers(requestInit.headers)
  if (provider === 'gitlab') headers.set('private-token', SYSTEM_MOCK_CODE_HOST_TOKEN)
  else headers.set('authorization', `Bearer ${SYSTEM_MOCK_CODE_HOST_TOKEN}`)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, {
    ...requestInit,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return response
}

async function apiJson<T = unknown>(
  provider: 'gitlab' | 'github',
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const response = await apiResponse(provider, path, init)
  const text = await response.text()
  if (!response.ok)
    throw new Error(
      `${provider} ${String(init.method ?? 'GET')} ${path}: ${response.status} ${text}`,
    )
  return (text.length === 0 ? undefined : JSON.parse(text)) as T
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}
