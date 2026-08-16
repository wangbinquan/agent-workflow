// RFC-304 §6.1 — the HTTP requests a review round actually sends.
//
// Every other test in this suite fakes the code host at the PORT, which proves
// the stage logic and proves nothing about whether the requests are ones GitLab
// or GitHub would accept. That gap is where the expensive mistakes live: a
// position object nested one level too deep, a review payload missing
// `commit_id`, a path built from the numeric project id on a host that only
// addresses by owner/repo. Each of those passes a port-level fake and fails
// against the real API — after being wired, deployed, and pointed at somebody's
// MR.
//
// So this file stubs `fetch` instead, and runs the round through the real
// `createCodeHostAdapter` → `executeCodeHostCall` path: real action registry,
// real path templating, real body mapping. What it asserts is the wire form.
//
// It cannot prove the hosts accept it — only a live MR does that (T4a3). It
// proves the layer under our control is not the reason they would not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createCodeHostAdapter } from '../src/modules/code-capability/infrastructure/codeHostAdapter'
import { createCodeCapabilityRunner } from '../src/modules/code-capability/composition/codeCapabilityRunner'
import {
  mrReviewAiStages,
  mrReviewProgramStages,
  type MrReviewEnvironment,
} from '../src/modules/code-capability/composition/mrReviewStages'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import { createGitPortFake } from './helpers/gitPortFake'
import type { CodeHostConnectionsService, FetchLike } from '../src/services/codeHost/connections'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NONCE = 'httpnonce'
const PATCH = '@@ -10,3 +10,4 @@\n context\n-removed\n+added one\n+added two\n context2\n'

interface Sent {
  method: string
  url: string
  body: unknown
}

function connections(provider: 'gitlab' | 'github'): CodeHostConnectionsService {
  return {
    resolve: () => ({
      provider,
      baseUrl: provider === 'gitlab' ? 'https://gitlab.example/api/v4' : 'https://api.github.com',
      repositoryUrlPrefixes: [],
      token: 'secret-token-value',
      rejectUnauthorized: true,
    }),
  } as unknown as CodeHostConnectionsService
}

/** Records every request and answers each endpoint the round touches. */
function stubHost(provider: 'gitlab' | 'github') {
  const sent: Sent[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = input
    const method = init?.method ?? 'GET'
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    sent.push({ method, url, body })

    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    if (url.includes('/diffs') || url.includes('/files')) {
      return json(
        provider === 'gitlab'
          ? [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: PATCH }]
          : [
              {
                filename: 'src/a.ts',
                status: 'modified',
                patch: PATCH,
                additions: 2,
                deletions: 1,
              },
            ],
      )
    }
    // The MR body: GitLab's diff_refs are what inline positions require.
    if (url.match(/merge_requests\/\d+$/) !== null || url.match(/pulls\/\d+$/) !== null) {
      return json({
        title: 'Add retry logic',
        diff_refs: { base_sha: 'base-sha', start_sha: 'start-sha', head_sha: HEAD },
      })
    }
    return json({ id: 99 })
  }
  return { sent, fetchImpl }
}

const webhookOf = (provider: 'gitlab' | 'github'): WebhookTriggerFields => ({
  event_type: 'mr_opened',
  provider,
  project_id: '41823',
  mr_iid: '412',
  commit_sha: HEAD,
  repo_path: 'group/project',
  mr_title: 'Add retry logic',
})

const FINDING = {
  file: 'src/a.ts',
  line: 11,
  severity: 'major',
  title: 'unchecked index',
  body: 'This can be undefined.',
}

const envelope = () =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({
    findings: [FINDING],
  })}</port></workflow-output>`

const fakeGit = (): GitPort => createGitPortFake({ resolvedSha: HEAD })

describe('RFC-304 — the wire form of a GitLab review', () => {
  let db: DbClient
  let home: string
  let sent: Sent[]

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-http-gl-'))
    const host = stubHost('gitlab')
    sent = host.sent
    const env: MrReviewEnvironment = {
      codeHost: createCodeHostAdapter({
        db,
        provider: 'gitlab',
        connections: connections('gitlab'),
        fetchImpl: host.fetchImpl,
      }),
      git: fakeGit(),
      webhook: webhookOf('gitlab'),
      codeHostEndpointId: 'ep_7',
      repoPath: home,
      worktreePath: home,
      makeCaller: () => async () => ({ stdout: envelope(), sessionId: 's1' }),
      protocolBlock: '',
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      gate: { threshold: 'info', maxPerRound: 20 },
    }
    const result = await createCodeCapabilityRunner({
      db,
      programStages: mrReviewProgramStages(env),
      aiStages: mrReviewAiStages(env),
    }).runRound({
      roundId: ulid(),
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })
    expect(result.outcome).toBe('done')
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('the project is addressed by its numeric id, url-encoded into the path', () => {
    // GitLab accepts the numeric id on `/projects/:id`, which is also the stable
    // identity — the one case where address and identity coincide.
    expect(sent[0]?.url).toContain('/projects/41823/merge_requests/412')
  })

  test('the diff is read from the MR, not recomputed locally', () => {
    expect(sent.some((s) => s.url.includes('/merge_requests/412/diffs'))).toBe(true)
  })

  test('the staged draft POSTs with a nested position object', () => {
    // GitLab wants `position` as an OBJECT, not a JSON string. The action
    // registry's `json-object` transform is what turns it back; a change that
    // dropped the transform would send a string and GitLab would reject it.
    //
    // T29 moved this from `/discussions` to `/draft_notes` — same wire contract,
    // different endpoint, because the review is now staged and published as one.
    const inline = sent.find((s) => s.url.endsWith('/draft_notes'))
    expect(inline?.method).toBe('POST')
    const body = inline?.body as Record<string, unknown>
    expect(typeof body?.position).toBe('object')
    expect(body?.position).toMatchObject({
      position_type: 'text',
      base_sha: 'base-sha',
      start_sha: 'start-sha',
      head_sha: HEAD,
      new_path: 'src/a.ts',
      new_line: 11,
    })
  })

  test('the comment body carries the finding and its fingerprint marker', () => {
    // `note`, not `body`: GitLab's draft_notes API names the text field
    // differently from its discussions API, and the registry maps it. Reading
    // `body` here would silently get `undefined` and assert nothing.
    const inline = sent.find((s) => s.url.endsWith('/draft_notes'))
    const body = String((inline?.body as Record<string, unknown>)?.note)
    expect(body).toContain('unchecked index')
    expect(body).toContain('aw-finding:')
  })

  test('the overview is a plain MR note, posted after the review itself', () => {
    const inlineAt = sent.findIndex((s) => s.url.endsWith('/draft_notes'))
    const overviewAt = sent.findIndex(
      (s, i) => i > inlineAt && s.method === 'POST' && s.url.includes('/notes'),
    )
    expect(inlineAt).toBeGreaterThanOrEqual(0)
    expect(overviewAt).toBeGreaterThan(inlineAt)
  })

  test('the token never appears in a URL', () => {
    // It belongs in a header. A token in a path lands in every proxy log there
    // is, and the round would still work — so nothing else would catch this.
    expect(sent.length).toBeGreaterThan(0) // else this sweep passes on nothing
    for (const s of sent) expect(s.url).not.toContain('secret-token-value')
  })
})

describe('RFC-304 — the wire form of a GitHub review', () => {
  let db: DbClient
  let home: string
  let sent: Sent[]

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-rfc304-http-gh-'))
    const host = stubHost('github')
    sent = host.sent
    const env: MrReviewEnvironment = {
      codeHost: createCodeHostAdapter({
        db,
        provider: 'github',
        connections: connections('github'),
        fetchImpl: host.fetchImpl,
      }),
      git: fakeGit(),
      webhook: webhookOf('github'),
      codeHostEndpointId: 'ep_7',
      repoPath: home,
      worktreePath: home,
      makeCaller: () => async () => ({ stdout: envelope(), sessionId: 's1' }),
      protocolBlock: '',
      nonce: NONCE,
      budget: { sameSession: 1, freshSession: 0 },
      gate: { threshold: 'info', maxPerRound: 20 },
    }
    const result = await createCodeCapabilityRunner({
      db,
      programStages: mrReviewProgramStages(env),
      aiStages: mrReviewAiStages(env),
    }).runRound({
      roundId: ulid(),
      capability: 'mr-review',
      roundSeq: 1,
      worktreePath: home,
      repos: [{ name: 'main', path: home }],
      envelopeNonce: NONCE,
      resumeFromStage: null,
    })
    expect(result.outcome).toBe('done')
  })
  afterEach(() => {
    db.$client.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('the repository is addressed by owner/repo, NOT by the numeric id', () => {
    // `/repos/41823/...` is not a route. This is the assertion that separates
    // the identity from the address, at the only place it becomes observable.
    expect(sent.length).toBeGreaterThan(0) // else the sweep below proves nothing
    expect(sent[0]?.url).toContain('/repos/group/project/pulls/412')
    expect(sent.every((s) => !s.url.includes('/repos/41823'))).toBe(true)
  })

  test('the whole review is ONE request to /reviews', () => {
    const reviews = sent.filter((s) => s.method === 'POST' && s.url.includes('/reviews'))
    expect(reviews).toHaveLength(1)
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1)
  })

  test('the review is pinned to the head sha the round read', () => {
    // Omitted, GitHub attaches the review to the PR's LATEST commit — so a push
    // landing mid-review silently moves every comment to a revision the
    // reviewer never saw.
    const review = sent.find((s) => s.url.includes('/reviews'))
    expect((review?.body as Record<string, unknown>)?.commit_id).toBe(HEAD)
  })

  test('the comments array is an ARRAY, with path/line/side per entry', () => {
    // The registry's `json-object` transform has to turn the packed string back
    // into structure; sending the string would make GitHub reject the review.
    const review = sent.find((s) => s.url.includes('/reviews'))
    const comments = (review?.body as Record<string, unknown>)?.comments
    expect(Array.isArray(comments)).toBe(true)
    expect((comments as unknown[])[0]).toMatchObject({
      path: 'src/a.ts',
      line: 11,
      side: 'RIGHT',
    })
  })

  test('it submits as COMMENT, never as an approval', () => {
    // Approving on someone's behalf is outside the product boundary.
    const review = sent.find((s) => s.url.includes('/reviews'))
    expect((review?.body as Record<string, unknown>)?.event).toBe('COMMENT')
  })

  test('the overview rides the review body rather than a second request', () => {
    const review = sent.find((s) => s.url.includes('/reviews'))
    expect(String((review?.body as Record<string, unknown>)?.body)).toContain('Reviewed')
  })

  test('the token never appears in a URL', () => {
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) expect(s.url).not.toContain('secret-token-value')
  })
})
