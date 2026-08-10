import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { McpRuntimeTestSessionDtoSchema, SessionViewResponseSchema } from '@agent-workflow/shared'
import { loadConfig } from '../src/config'
import { createInMemoryDb } from '../src/db/client'
import { runtimes } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'
import { createApp } from '../src/server'

const TOKEN = 'rfc238-http-token'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

async function harness(): Promise<{ app: Hono; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'rfc238-http-'))
  tempDirs.push(root)
  const configPath = join(root, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  db.update(runtimes).set({ model: 'openai/test-model' }).where(eq(runtimes.name, 'opencode')).run()
  let runIndex = 0
  const runFn = async (opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> => {
    runIndex += 1
    await opts.onSpawned?.({
      pid: 6000 + runIndex,
      spawnedAt: Date.now(),
      spawnBinaryPath: '/mock/opencode',
    })
    await opts.eventSink?.setRootSessionId('native-http-session')
    await opts.eventSink?.append({
      ts: Date.now(),
      kind: 'text',
      payload: JSON.stringify({
        type: 'text',
        sessionID: 'native-http-session',
        messageID: `assistant-${runIndex}`,
        part: { type: 'text', text: `answer-${runIndex}` },
      }),
      sessionId: 'native-http-session',
      parentSessionId: null,
      source: 'stream',
      externalEventId: `assistant-${runIndex}`,
    })
    await opts.eventSink?.markTerminal('complete')
    return {
      status: 'ok',
      exitCode: 0,
      eventText: '',
      stderrTail: '',
      durationMs: 5,
      capturedSessionId: 'native-http-session',
      scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unknown'),
      scratchRetained: true,
      outputEvidence: emptySystemAgentOutputEvidence(),
    }
  }
  return {
    root,
    app: createApp({
      token: TOKEN,
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
      mcpRuntimeTestDependencies: { appHome: root, runFn },
    }),
  }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function waitForSession(
  app: Hono,
  mcpId: string,
  sessionId: string,
  done: (session: ReturnType<typeof McpRuntimeTestSessionDtoSchema.parse>) => boolean,
): Promise<ReturnType<typeof McpRuntimeTestSessionDtoSchema.parse>> {
  const deadline = Date.now() + 2_000
  while (true) {
    const response = await req(
      app,
      `/api/mcps/${encodeURIComponent(mcpId)}/runtime-test-sessions/${encodeURIComponent(
        sessionId,
      )}`,
    )
    expect(response.status).toBe(200)
    const session = McpRuntimeTestSessionDtoSchema.parse(await response.json())
    if (done(session)) return session
    if (Date.now() >= deadline) throw new Error('MCP runtime test HTTP session timed out')
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 MCP runtime playground HTTP contract', () => {
  test('creates, restores, resumes, renders, and immediately ends one private session', async () => {
    const { app } = await harness()
    const runtimeResponse = await req(app, '/api/runtimes')
    expect(runtimeResponse.status).toBe(200)
    const runtimeBody = (await runtimeResponse.json()) as {
      runtimes: Array<{
        name: string
        capabilities?: { mcpRuntimeTestV1?: boolean }
      }>
    }
    expect(
      runtimeBody.runtimes.find((runtime) => runtime.name === 'opencode')?.capabilities
        ?.mcpRuntimeTestV1,
    ).toBe(true)
    expect(
      runtimeBody.runtimes.find((runtime) => runtime.name === 'claude-code')?.capabilities
        ?.mcpRuntimeTestV1,
    ).toBe(true)

    const mcpResponse = await req(app, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'runtime-fixture',
        description: '',
        type: 'local',
        config: { command: ['/mock/mcp'] },
        enabled: true,
      }),
    })
    expect(mcpResponse.status).toBe(201)
    const mcp = (await mcpResponse.json()) as {
      id: string
      operationConfigHash: string
    }
    expect((await req(app, `/api/mcps/${mcp.id}/runtime-test-session`)).status).toBe(204)

    const createResponse = await req(app, `/api/mcps/${mcp.id}/runtime-test-sessions`, {
      method: 'POST',
      body: JSON.stringify({
        expectedMcpConfigHash: mcp.operationConfigHash,
        runtimeName: 'opencode',
        message: 'first HTTP turn',
        clientCreateId: 'http-create-1',
        clientMessageId: 'http-message-1',
      }),
    })
    expect(createResponse.status).toBe(202)
    const receipt = (await createResponse.json()) as {
      sessionId: string
      acceptedTurnId: string
    }
    let session = await waitForSession(
      app,
      mcp.id,
      receipt.sessionId,
      (candidate) => candidate.inFlightTurnId === null,
    )
    expect(session.nativeSessionReady).toBe(true)
    expect(session.turns.map((turn) => turn.prompt)).toEqual(['first HTTP turn'])

    const latest = await req(app, `/api/mcps/${mcp.id}/runtime-test-session`)
    expect(latest.status).toBe(200)
    expect(McpRuntimeTestSessionDtoSchema.parse(await latest.json()).id).toBe(receipt.sessionId)

    const secondResponse = await req(
      app,
      `/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: 'second HTTP turn',
          clientMessageId: 'http-message-2',
          expectedSessionVersion: session.sessionVersion,
        }),
      },
    )
    expect(secondResponse.status).toBe(202)
    session = await waitForSession(
      app,
      mcp.id,
      receipt.sessionId,
      (candidate) => candidate.inFlightTurnId === null && candidate.turns.length === 2,
    )
    expect(session.turns.map((turn) => turn.prompt)).toEqual([
      'first HTTP turn',
      'second HTTP turn',
    ])

    const viewResponse = await req(
      app,
      `/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}/session`,
    )
    expect(viewResponse.status).toBe(200)
    expect(SessionViewResponseSchema.safeParse(await viewResponse.json()).success).toBe(true)

    const invalidEnd = await req(
      app,
      `/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}/end`,
      { method: 'POST', body: JSON.stringify({ force: true }) },
    )
    expect(invalidEnd.status).toBe(422)
    expect((await invalidEnd.json()) as { code?: string }).toMatchObject({
      code: 'mcp-test-invalid',
    })

    const endResponse = await req(
      app,
      `/api/mcps/${mcp.id}/runtime-test-sessions/${receipt.sessionId}/end`,
      { method: 'POST', body: '{}' },
    )
    expect(endResponse.status).toBe(200)
    const ended = McpRuntimeTestSessionDtoSchema.parse(
      ((await endResponse.json()) as { session: unknown }).session,
    )
    expect(ended.status).toBe('ended')
    expect(ended.endReason).toBe('user')
  })

  test('all playground endpoints remain authenticated', async () => {
    const { app } = await harness()
    expect((await app.request('/api/mcps/unknown/runtime-test-session')).status).toBe(401)

    const invalid = await req(app, '/api/mcps/unknown/runtime-test-sessions', {
      method: 'POST',
      body: '{}',
    })
    expect((await invalid.json()) as { code?: string }).toMatchObject({
      code: 'mcp-test-invalid',
    })
  })
})
