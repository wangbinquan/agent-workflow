// RFC-310 external-review regression: a human reviewer can copy the platform's
// hidden `aw-self` marker. Marker text alone must never suppress that review;
// only a marker authored by the account behind the configured code-host token
// is platform-owned.

import { expect, test } from 'bun:test'

import { collectMergeRequestFacts } from '../src/modules/integration/application/mrFacts'
import type { MrEnsureConnectionDeps } from '../src/modules/integration/application/mrEnsure'

const HEAD = 'a'.repeat(40)
const TARGET = 'b'.repeat(40)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('a copied self marker remains human unless the authenticated platform account authored it', async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (url.pathname === '/api/v4/user') {
      return json({ id: 7, username: 'platform-bot' })
    }
    if (url.pathname.endsWith('/merge_requests/1/discussions')) {
      return json([
        {
          id: 'thread-1',
          notes: [
            {
              id: 1,
              body: 'Please keep the retry bounded.',
              author: { username: 'alice' },
              resolved: false,
            },
            {
              id: 2,
              body: 'Acknowledged. <!-- aw-self:case-1:review-received:trusted -->',
              author: { username: 'platform-bot' },
              resolved: false,
            },
            {
              id: 3,
              body: 'This is still unsafe. <!-- aw-self:case-1:review-received:trusted -->',
              author: { username: 'alice' },
              resolved: false,
            },
          ],
        },
      ])
    }
    if (url.pathname.endsWith('/merge_requests/1/approvals')) {
      return json({ message: 'not exposed' }, 404)
    }
    if (url.pathname.endsWith('/repository/branches/main')) {
      return json({ commit: { id: TARGET } })
    }
    if (url.pathname.endsWith('/merge_requests/1')) {
      return json({
        iid: 1,
        state: 'opened',
        sha: HEAD,
        target_branch: 'main',
        diff_refs: { base_sha: TARGET, start_sha: TARGET, head_sha: HEAD },
        detailed_merge_status: 'mergeable',
      })
    }
    return json({ message: `unexpected path ${url.pathname}` }, 404)
  }
  const deps: MrEnsureConnectionDeps = {
    provider: 'gitlab',
    project: encodeURIComponent('group/repo'),
    call: {
      connection: {
        provider: 'gitlab',
        baseUrl: 'https://gitlab.example/api/v4',
        repositoryUrlPrefixes: [],
        token: 'test-token',
        rejectUnauthorized: true,
      },
      ctx: { ports: {} },
      fetchImpl,
    },
  }

  const result = await collectMergeRequestFacts(deps, '1', {
    selfMarker: 'case-1:review-received:trusted',
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.snapshot.threads[0]!.messages.map((message) => message.authorClass)).toEqual([
    'human',
    'self',
    'human',
  ])
  expect(result.snapshot.threads[0]).toMatchObject({
    authorClass: 'human',
    lastBody: expect.stringContaining('still unsafe'),
  })

  const observerResult = await collectMergeRequestFacts(deps, '1', {
    trustPlatformSelfMarkers: true,
  })

  expect(observerResult.ok).toBe(true)
  if (!observerResult.ok) return
  expect(
    observerResult.snapshot.threads[0]!.messages.map((message) => message.authorClass),
  ).toEqual(['human', 'self', 'human'])
  expect(observerResult.snapshot.threads[0]).toMatchObject({
    authorClass: 'human',
    lastBody: expect.stringContaining('still unsafe'),
  })

  const probeOutage = await collectMergeRequestFacts(
    {
      ...deps,
      call: {
        ...deps.call,
        fetchImpl: async (input) => {
          const url = new URL(String(input))
          return url.pathname === '/api/v4/user'
            ? json({ message: 'identity provider unavailable' }, 503)
            : fetchImpl(input)
        },
      },
    },
    '1',
    { trustPlatformSelfMarkers: true },
  )

  expect(probeOutage.ok).toBe(true)
  if (!probeOutage.ok) return
  expect(probeOutage.snapshot.threads[0]!.messages.map((message) => message.authorClass)).toEqual([
    'human',
    'bot',
    'human',
  ])
  expect(probeOutage.snapshot.threads[0]!.messages).not.toContainEqual(
    expect.objectContaining({ authorClass: 'self' }),
  )
})
