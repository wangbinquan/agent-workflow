// RFC-370 v3 — a hosted instance boots and serves on standby, and starts its
// background owners only once it holds the CrewStation execution lease.
//
// WHY THIS FILE EXISTS (regression intent): the first v3 release on a real
// CrewStation crash-looped in its new slot. The platform registers a release's
// task contract only when the slot becomes ready, so a new instance is refused
// the lease at boot (`release_contract_missing`) — but the daemon composed the
// MCP runtime-test service with an eager pause, which runs the service's boot
// recovery (fenced writes) during composition. Without the lease the fence
// threw, the process exited 1 ("this instance no longer holds the CrewStation
// execution lease (standby)"), the slot never became ready, and the contract
// was never registered: a deadlock no unit case saw, because every hosted
// fixture starts active. This spawns the real daemon against the harness
// PostgreSQL and an in-test platform that first refuses and then grants it.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { migrateForDeployment } from '@/cli/deployment'
import { currentDatabaseSchemaProvider, selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { hostedExecutionControl } from '@/db/schema'
import { prepareCrewStationDatabase } from '@/modules/system-operations/composition/crewstationDeployment'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'

const PROJECT = 'agent-workflow'
const providers = resolveTestProviders(process.env)

if (providers.includes('postgresql')) {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const databaseUrl = (): string => {
    const url = urlEnv === undefined ? undefined : process.env[urlEnv]
    if (url === undefined || url.length === 0)
      throw new Error('the hosted standby boot requires the real harness PostgreSQL URL')
    return url
  }
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc370-standby-'))
  // The in-process Job and verify select the PostgreSQL schema provider
  // process-wide; restore it for the files that run after this one.
  const previousSchemaProvider = currentDatabaseSchemaProvider()
  afterAll(() => {
    selectDatabaseSchemaProvider(previousSchemaProvider)
    rmSync(home, { recursive: true, force: true })
  })

  async function emptyDatabase(): Promise<void> {
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv }),
      generationId: 'dbg_rfc370_standby_reset',
    })
    try {
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
      await runtime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
    } finally {
      await runtime.close()
    }
  }

  /** The platform refuses business execution until `granted`, then grants one lease. */
  function fakePlatform() {
    const requests: string[] = []
    let granted = false
    let control: Record<string, unknown> = {
      epoch: 0,
      phase: 'inactive',
      leaseOwner: null,
      leaseExpiresAt: null,
    }
    const expiry = () => new Date(Date.now() + 60_000).toISOString()
    const root = '/v3/business-execution/control'
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(`${request.method} ${path}`)
        if (path.includes('jwks')) return Response.json({ keys: [] })
        if (!path.startsWith('/v3/business-execution'))
          return Response.json({ error: 'not_found' }, { status: 404 })
        if (!granted)
          return Response.json(
            {
              error: 'precondition',
              message: 'source release has no registered task contract',
              details: { code: 'release_contract_missing' },
            },
            { status: 412 },
          )
        const body = (request.method === 'POST' ? await request.json() : {}) as {
          instanceId?: string
        }
        if (path === root) return Response.json(control)
        if (path === `${root}/claim`) {
          control = {
            epoch: 1,
            phase: 'preparing',
            leaseOwner: body.instanceId ?? null,
            leaseExpiresAt: expiry(),
            leaseId: 'lease-standby-boot',
          }
          return Response.json(control)
        }
        if (path === `${root}/renew` || path === `${root}/activate`) {
          control = {
            ...control,
            leaseExpiresAt: expiry(),
            ...(path.endsWith('/activate') ? { phase: 'active' } : {}),
          }
          return Response.json(control)
        }
        return Response.json({ items: [], next: null })
      },
    })
    return {
      url: `http://127.0.0.1:${server.port}`,
      requests,
      grant: () => {
        granted = true
      },
      stop: () => server.stop(true),
    }
  }

  function freePort(): number {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const port = probe.port!
    probe.stop(true)
    return port
  }

  async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await check()) return
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await Bun.sleep(250)
    }
  }

  test('a standby instance serves without the lease and starts background owners on activation', async () => {
    await emptyDatabase()
    await migrateForDeployment({
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: PROJECT,
      CS_SERVICE: PROJECT,
      CS_DATABASE_URL: databaseUrl(),
    })
    const platform = fakePlatform()
    const port = freePort()
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !/^(https?|no)_proxy$/i.test(key)) env[key] = value
    Object.assign(env, {
      AGENT_WORKFLOW_HOME: home,
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: PROJECT,
      CS_SERVICE: PROJECT,
      CS_DATABASE_URL: databaseUrl(),
      CS_JWKS_URL: `${platform.url}/jwks.json`,
      CS_PLATFORM_API_URL: platform.url,
      CS_OBJECTS_URL: platform.url,
      CS_OBJECT_SPACE_ID: '01a0e955-76e5-7000-9280-2bea2b2e88d3',
      PORT: String(port),
      AW_SECRET_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      AW_AGENT_PROFILES: JSON.stringify([
        {
          protocol: 'opencode',
          model: null,
          agentProfileId: '01a146ce-c2ce-7893-85a2-e13a1ab95c58',
        },
      ]),
    })
    let output = ''
    const daemon = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        fileURLToPath(new URL('../src/main.ts', import.meta.url)),
        'start',
      ],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output += decoder.decode(chunk)
    }
    const drained = Promise.all([drain(daemon.stdout), drain(daemon.stderr)])
    const status = async (path: string) =>
      await fetch(`http://127.0.0.1:${port}${path}`)
        .then((response) => response.status)
        .catch(() => 0)
    const serving = prepareCrewStationDatabase({
      environment: { project: PROJECT, service: PROJECT },
      schema: 'verify',
      env: { CS_DATABASE_URL: databaseUrl() },
    })
    try {
      await until(
        async () => (await status('/ready')) === 200,
        60_000,
        'the standby instance to be ready',
      )
      // Refused at least twice: still serving, and nothing fenced was written.
      await until(
        () =>
          platform.requests.filter((entry) => entry === 'GET /v3/business-execution/control')
            .length >= 2,
        30_000,
        'a retried lease claim',
      )
      expect(daemon.exitCode, output).toBeNull()
      expect(await status('/live')).toBe(200)
      expect(await status('/ready')).toBe(200)
      const db = (await serving).openBootstrapClient()
      const before = await db
        .select()
        .from(hostedExecutionControl)
        .where(eq(hostedExecutionControl.id, 'global'))
      expect(before.filter((row) => row.phase === 'active')).toEqual([])

      platform.grant()
      await until(() => output.includes('crewstation execution lease active'), 30_000, 'activation')
      expect(platform.requests).toContain('POST /v3/business-execution/control/activate')
      // Background owners started on activation; the instance keeps serving.
      await Bun.sleep(3_000)
      expect(daemon.exitCode, output).toBeNull()
      expect(await status('/ready')).toBe(200)
      const after = await db
        .select()
        .from(hostedExecutionControl)
        .where(eq(hostedExecutionControl.id, 'global'))
      expect(after.map((row) => row.phase)).toEqual(['active'])
      expect(output).not.toContain('no longer holds the CrewStation execution lease')
    } finally {
      daemon.kill('SIGTERM')
      await Promise.race([daemon.exited, Bun.sleep(40_000)])
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
      await daemon.exited
      await drained.catch(() => undefined)
      await (await serving.catch(() => undefined))?.runtime.close()
      platform.stop()
    }
  }, 180_000)
}
