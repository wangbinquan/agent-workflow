// RFC-224 regression lock: every request to the private OpenCode server is
// loopback-only, authenticated, directory-bound, no-redirect, and bounded.

import { describe, expect, test } from 'bun:test'
import { OpencodeDirectClient, DirectHttpError } from '@/services/runtime/opencode/directClient'
import {
  ROOT_SESSION_PERMISSION_RULES,
  buildCreateSessionRequest,
} from '@/services/runtime/opencode/directApiSchemas'

const sessionID = 'ses_000000001001AAAAAAAAAAAAAA'
const directory = '/private/tmp/rfc224-worktree'
const password = 'do-not-leak-this-password'

function session() {
  return {
    id: sessionID,
    slug: 'quiet-moon',
    projectID: 'project-1',
    directory,
    title: 'agent-workflow:run-1',
    agent: 'worker',
    model: { providerID: 'openai', id: 'gpt-5.6' },
    version: '1.18.3',
    time: { created: 1, updated: 1 },
    permission: ROOT_SESSION_PERMISSION_RULES.map((rule) => ({ ...rule })),
  }
}

function client(fetchImpl: ConstructorParameters<typeof OpencodeDirectClient>[0]['fetch']) {
  return new OpencodeDirectClient({
    origin: 'http://127.0.0.1:4096',
    directory,
    username: 'opencode',
    password,
    fetch: fetchImpl,
  })
}

describe('RFC-224 direct HTTP client request boundary', () => {
  test('adds Basic auth + canonical directory and disables redirects', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const instance = client(async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return Response.json(session())
    })
    await instance.createSession(
      buildCreateSessionRequest({
        title: 'agent-workflow:run-1',
        agent: 'worker',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      }),
    )

    const url = new URL(capturedUrl)
    expect(url.origin).toBe('http://127.0.0.1:4096')
    expect(url.pathname).toBe('/session')
    expect(url.searchParams.get('directory')).toBe(directory)
    expect(capturedUrl).not.toContain(password)
    expect(capturedInit?.redirect).toBe('error')
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    )
    expect(headers.Accept).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
  })

  test('rejects non-loopback origins, URL credentials/paths, and noncanonical directories', () => {
    const base = {
      directory,
      username: 'opencode',
      password,
      fetch: async () => Response.json({}),
    }
    for (const origin of [
      'https://127.0.0.1:4096',
      'http://localhost:4096',
      'http://127.0.0.1',
      'http://user@127.0.0.1:4096',
      'http://127.0.0.1:4096/api',
    ]) {
      expect(() => new OpencodeDirectClient({ ...base, origin })).toThrow('http://127.0.0.1:<port>')
    }
    expect(
      () =>
        new OpencodeDirectClient({
          ...base,
          origin: 'http://127.0.0.1:4096',
          directory: '/private/tmp/../foreign',
        }),
    ).toThrow('canonical absolute path')
  })

  test('uses exact root-session inventory query and preserves the raw next cursor header', async () => {
    let captured = ''
    const instance = client(async (url) => {
      captured = url
      return Response.json([{ ...session(), project: null }], {
        headers: { 'x-next-cursor': '123' },
      })
    })
    const page = await instance.listRootSessions({
      title: 'agent-workflow:run-1',
      cursor: 456,
    })
    const url = new URL(captured)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      directory,
      roots: 'true',
      search: 'agent-workflow:run-1',
      limit: '100',
      cursor: '456',
    })
    expect(page.nextCursorHeader).toBe('123')
    expect(page.sessions[0]?.id).toBe(sessionID)
  })

  test('rejects redirects, non-2xx, wrong content type, oversized body, and malformed JSON', async () => {
    const cases: Array<{
      response: () => Response
      reason: string
      budgets?: { maxJsonBytes: number }
    }> = [
      {
        response: () =>
          new Response(null, { status: 302, headers: { location: 'http://example.com' } }),
        reason: 'unexpected-status',
      },
      {
        response: () => new Response('denied', { status: 401 }),
        reason: 'unexpected-status',
      },
      {
        response: () =>
          new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
        reason: 'unexpected-content-type',
      },
      {
        response: () =>
          new Response('{"too":"large"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        reason: 'body-budget-exceeded',
        budgets: { maxJsonBytes: 4 },
      },
      {
        response: () =>
          new Response(`{"password":"${password}"`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        reason: 'malformed-json',
      },
    ]
    for (const item of cases) {
      const instance = new OpencodeDirectClient({
        origin: 'http://127.0.0.1:4096',
        directory,
        username: 'opencode',
        password,
        fetch: async () => item.response(),
        ...(item.budgets === undefined ? {} : { budgets: item.budgets }),
      })
      let error: unknown
      try {
        await instance.abortSession(sessionID)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(DirectHttpError)
      expect((error as DirectHttpError).reason).toBe(item.reason)
      expect(String(error)).not.toContain(password)
    }
  })

  test('SSE subscription validates content type and returns the bounded parser stream', async () => {
    const frame =
      'event: message\n' +
      `data: ${JSON.stringify({
        id: 'evt_000000001001AAAAAAAAAAAAAA',
        type: 'server.connected',
        properties: {},
      })}\n\n`
    const instance = client(async () => {
      return new Response(frame, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    })
    const events = await instance.subscribeEvents()
    expect((await events.next()).value).toEqual({
      id: 'evt_000000001001AAAAAAAAAAAAAA',
      type: 'server.connected',
      properties: {},
    })
    expect((await events.next()).done).toBe(true)
  })

  test('fetch errors and caller aborts collapse to non-secret stable reasons', async () => {
    const failed = client(async () => {
      throw new Error(password)
    })
    await expect(failed.abortSession(sessionID)).rejects.toMatchObject({
      reason: 'request-failed',
    })

    const controller = new AbortController()
    controller.abort(password)
    const aborted = client(async () => {
      throw new Error(password)
    })
    let error: unknown
    try {
      await aborted.abortSession(sessionID, controller.signal)
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ reason: 'request-aborted' })
    expect(String(error)).not.toContain(password)
  })
})
