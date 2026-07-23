// RFC-112 PR-B — runtime registry HTTP routes: GET open to any authed user;
// all writes + /probe admin-only (D3). Built-in read-only + in-use delete guards
// surface as 403 / 409. The deep-smoke /probe is exercised once with a mock
// binary (full smoke coverage lives in runtime-smoke.test.ts); CRUD cases use
// probe:false to stay fast and not spawn.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { applyConfigPatch, loadConfig } from '../src/config'
import { createApp, type RuntimeDiagnosticTestDependencies } from '../src/server'
import { createUser } from '../src/services/users'
import {
  createRuntime,
  deleteRuntime,
  getRuntime,
  seedBuiltinRuntimes,
} from '../src/services/runtimeRegistry'
import type { SmokeOptions, SmokeResult } from '../src/services/runtimeSmoke'
import { agents } from '../src/db/schema'
import { ulid } from 'ulid'
import { FIXTURE_RUNTIME_DIAGNOSTICS } from './helpers/officialOpencodeFixture'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// opencode protocol has NO credential bridge, so the route /probe test (which
// passes bridgeCredentials:true for production-fidelity) never touches a keychain.
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
  configPath: string
  userToken: string
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rt-reg-'))
  const configPath = join(tmp, 'config.json')
  loadConfig(configPath)
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    runtimeDiagnosticTestDependencies: FIXTURE_RUNTIME_DIAGNOSTICS,
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: bob.id })
  return { db, app, tmp, configPath, userToken: token }
}

async function reqAs(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function wrapperFor(mockFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rt-bin-'))
  const wrapper = join(dir, 'runtime-bin')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${mockFile} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const CONFORMING_SMOKE: SmokeResult = {
  outcome: 'conforms',
  conforms: true,
  detail: 'deterministic delayed probe',
  sawNonce: true,
  sawEnvelope: false,
  exitCode: 0,
}

function appWithSmoke(
  h: Harness,
  smokeRuntime: (options: SmokeOptions) => Promise<SmokeResult>,
  beforeRuntimeProbeCache?: () => void | Promise<void>,
): Hono {
  const runtimeDiagnosticTestDependencies: RuntimeDiagnosticTestDependencies = {
    ...FIXTURE_RUNTIME_DIAGNOSTICS,
    smokeRuntime,
    ...(beforeRuntimeProbeCache !== undefined ? { beforeRuntimeProbeCache } : {}),
  }
  return createApp({
    token: DAEMON_TOKEN,
    configPath: h.configPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db: h.db,
    runtimeDiagnosticTestDependencies,
  })
}

describe('runtime registry routes (RFC-112 PR-B)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => rmSync(h.tmp, { recursive: true, force: true }))

  test('GET /api/runtimes lists the seeded runtimes (open to any user)', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/runtimes')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { runtimes: Array<{ name: string }> }
    const names = json.runtimes.map((r) => r.name).sort()
    expect(names).toEqual(['claude-code', 'opencode'])
    // RFC-153: the built-in flag is gone from the wire shape entirely.
    expect(json.runtimes.some((r) => 'builtin' in r)).toBe(false)
  })

  test('POST /api/runtimes (admin, probe:false) registers a custom runtime → 201', async () => {
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({
        name: 'my-oc',
        protocol: 'opencode',
        binaryPath: '/a/my-oc',
        model: 'openai/gpt-5.6',
        probe: false,
      }),
    })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { runtime: { name: string; protocol: string } }
    expect(json.runtime.name).toBe('my-oc')
    expect(json.runtime.protocol).toBe('opencode')
  })

  test('POST /api/runtimes with probe stores and displays a target-bound receipt', async () => {
    const app = appWithSmoke(h, async () => CONFORMING_SMOKE)
    const res = await reqAs(app, DAEMON_TOKEN, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({
        name: 'create-probed',
        protocol: 'claude-code',
        binaryPath: '/fixture-claude',
        probe: true,
      }),
    })

    expect(res.status).toBe(201)
    const json = (await res.json()) as {
      runtime: { name: string; lastProbe: SmokeResult | null }
    }
    expect(json.runtime).toMatchObject({
      name: 'create-probed',
      lastProbe: CONFORMING_SMOKE,
    })
    const stored = await getRuntime(h.db, 'create-probed')
    expect(JSON.parse(stored!.lastProbeJson!)).toMatchObject({
      codec: 1,
      target: {
        id: stored!.id,
        name: 'create-probed',
        probeFence: 0,
        resolvedBinaryPath: '/fixture-claude',
      },
      smoke: CONFORMING_SMOKE,
    })
  })

  test('POST /api/runtimes is admin-only → 403 for a regular user', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({ name: 'sneaky', protocol: 'opencode', probe: false }),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/runtimes with an existing preseeded name → 409 runtime-exists (not reserved)', async () => {
    // RFC-153: opencode is no longer a reserved name — it collides only because the
    // preseeded row already exists (name uniqueness), which reads as runtime-exists.
    const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes', {
      method: 'POST',
      body: JSON.stringify({
        name: 'opencode',
        protocol: 'opencode',
        model: 'openai/gpt-5.6',
        probe: false,
      }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('runtime-exists')
  })

  test('PUT /api/runtimes/:name updates a custom binary; built-in PUT now ALLOWED (RFC-113 D8)', async () => {
    await createRuntime(h.db, { name: 'my-oc', protocol: 'opencode', binaryPath: '/a' })
    const ok = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/my-oc', {
      method: 'PUT',
      body: JSON.stringify({ binaryPath: '/b', model: 'opus' }),
    })
    expect(ok.status).toBe(200)
    const okJson = (await ok.json()) as { runtime: { binaryPath: string; model: string } }
    expect(okJson.runtime.binaryPath).toBe('/b')
    expect(okJson.runtime.model).toBe('opus')

    // RFC-113: built-in binary/model IS editable (config面). Only identity/delete locked.
    const builtin = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ binaryPath: '/x', model: 'sonnet' }),
    })
    expect(builtin.status).toBe(200)
    expect(((await builtin.json()) as { runtime: { model: string } }).runtime.model).toBe('sonnet')
  })

  test.each([null, '   '])(
    'PUT rejects clearing an OpenCode model with %p and preserves the valid profile',
    async (model) => {
      await createRuntime(h.db, {
        name: 'policy-oc',
        protocol: 'opencode',
        model: 'openai/gpt-5.6',
      })

      const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/policy-oc', {
        method: 'PUT',
        body: JSON.stringify({ model }),
      })

      expect(res.status).toBe(422)
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        code: 'execution-identity-model-unresolved',
      })
      const list = await reqAs(h.app, h.userToken, '/api/runtimes')
      const rows = (await list.json()) as {
        runtimes: Array<{ name: string; model: string | null }>
      }
      expect(rows.runtimes.find((runtime) => runtime.name === 'policy-oc')?.model).toBe(
        'openai/gpt-5.6',
      )
    },
  )

  test('DELETE custom ok; preseeded claude-code ok (RFC-153); in-use → 409', async () => {
    await createRuntime(h.db, { name: 'my-oc', protocol: 'opencode' })
    const del = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/my-oc', { method: 'DELETE' })
    expect(del.status).toBe(200)

    // RFC-153: claude-code is an ordinary row now — deletable (not the effective
    // default, not referenced). The default opencode stays protected (F1).
    const preseeded = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/claude-code', {
      method: 'DELETE',
    })
    expect(preseeded.status).toBe(200)

    await createRuntime(h.db, { name: 'used-rt', protocol: 'opencode' })
    await h.db.insert(agents).values({ id: ulid(), name: 'auditor', runtime: 'used-rt' })
    const inUse = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/used-rt', { method: 'DELETE' })
    expect(inUse.status).toBe(409)
    expect(((await inUse.json()) as { code: string }).code).toBe('runtime-in-use')
  })

  // RFC-118: enable/disable toggle.
  test('POST /:name/enabled: disable non-default built-in ok; default → 409; user → 403', async () => {
    // disable a non-default built-in (claude-code) → 200, enabled=false
    const dis = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/claude-code/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })
    expect(dis.status).toBe(200)
    expect(((await dis.json()) as { runtime: { enabled: boolean } }).runtime.enabled).toBe(false)

    // disabling the effective default (opencode) → 409
    const def = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: false }),
    })
    expect(def.status).toBe(409)
    expect(((await def.json()) as { code: string }).code).toBe('runtime-default-cannot-disable')

    // admin-only → 403 for a regular user
    const forbidden = await reqAs(h.app, h.userToken, '/api/runtimes/claude-code/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    expect(forbidden.status).toBe(403)
  })

  test('POST /api/runtimes/probe deep-smokes a mock binary → conforms', async () => {
    process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
    process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
    try {
      const res = await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/probe', {
        method: 'POST',
        body: JSON.stringify({
          protocol: 'opencode',
          binaryPath: wrapperFor(MOCK_OPENCODE),
          model: 'openai/gpt-5.6',
        }),
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { smoke: { outcome: string; conforms: boolean } }
      expect(json.smoke.outcome).toBe('conforms')
      expect(json.smoke.conforms).toBe(true)
    } finally {
      delete process.env.MOCK_OPENCODE_ECHO_PROMPT
      delete process.env.MOCK_OPENCODE_EMIT_SESSION_ID
    }
  }, 30_000)

  test('saved-runtime probe rejects a receipt after a concurrent execution-profile PUT', async () => {
    await createRuntime(h.db, {
      name: 'probe-profile-race',
      protocol: 'opencode',
      binaryPath: '/old-opencode',
      model: 'openai/gpt-5.6',
    })
    const entered = deferred<void>()
    const finish = deferred<SmokeResult>()
    let probed: SmokeOptions | null = null
    let reachedProbeCacheBoundary = false
    const app = appWithSmoke(
      h,
      async (options) => {
        probed = options
        entered.resolve()
        return finish.promise
      },
      () => {
        reachedProbeCacheBoundary = true
      },
    )

    const pending = reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-profile-race/probe', {
      method: 'POST',
    })
    await entered.promise
    expect(probed).toMatchObject({
      binaryPath: '/old-opencode',
      model: 'openai/gpt-5.6',
    })

    const changed = await reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-profile-race', {
      method: 'PUT',
      body: JSON.stringify({
        model: 'openai/gpt-5.7',
      }),
    })
    expect(changed.status).toBe(200)
    const changedRow = (await getRuntime(h.db, 'probe-profile-race'))!
    expect(changedRow.binaryPath).toBe('/old-opencode')
    expect(changedRow.probeFence).toBe(1)
    finish.resolve(CONFORMING_SMOKE)

    const stale = await pending
    expect(stale.status).toBe(409)
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({
      code: 'runtime-probe-stale',
    })
    expect(reachedProbeCacheBoundary).toBe(true)
    expect((await getRuntime(h.db, 'probe-profile-race'))?.lastProbeJson).toBeNull()
  })

  test('saved-runtime probe cannot attach to a delete + same-name recreation', async () => {
    const original = await createRuntime(h.db, {
      name: 'probe-recreate-race',
      protocol: 'claude-code',
      binaryPath: '/same-binary',
    })
    const entered = deferred<void>()
    const finish = deferred<SmokeResult>()
    const app = appWithSmoke(h, async () => {
      entered.resolve()
      return finish.promise
    })

    const pending = reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-recreate-race/probe', {
      method: 'POST',
    })
    await entered.promise
    await deleteRuntime(h.db, 'probe-recreate-race', {})
    const replacement = await createRuntime(h.db, {
      name: 'probe-recreate-race',
      protocol: 'claude-code',
      binaryPath: '/same-binary',
    })
    expect(replacement.id).not.toBe(original.id)
    finish.resolve(CONFORMING_SMOKE)

    const stale = await pending
    expect(stale.status).toBe(409)
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({
      code: 'runtime-probe-stale',
    })
    expect((await getRuntime(h.db, 'probe-recreate-race'))?.lastProbeJson).toBeNull()
  })

  test('saved-runtime probe rejects a receipt after its inherited config binary changes', async () => {
    await createRuntime(h.db, {
      name: 'probe-config-race',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    // Config PUT validates every inherited system-agent runtime under RFC-224.
    // Make the effective default model explicit, then establish the old head.
    await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ model: 'openai/gpt-5.6' }),
    })
    applyConfigPatch(h.configPath, { opencodePath: '/old-config-opencode' })

    const entered = deferred<void>()
    const finish = deferred<SmokeResult>()
    let probed: SmokeOptions | null = null
    const app = appWithSmoke(h, async (options) => {
      probed = options
      entered.resolve()
      return finish.promise
    })
    const pending = reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-config-race/probe', {
      method: 'POST',
    })
    await entered.promise
    expect(probed).toMatchObject({ binaryPath: '/old-config-opencode' })

    const changed = await reqAs(app, DAEMON_TOKEN, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ opencodePath: '/new-config-opencode' }),
    })
    expect(changed.status).toBe(200)
    finish.resolve(CONFORMING_SMOKE)

    const stale = await pending
    expect(stale.status).toBe(409)
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({
      code: 'runtime-probe-stale',
    })
    expect((await getRuntime(h.db, 'probe-config-race'))?.lastProbeJson).toBeNull()
  })

  test('config path change persistently invalidates completed inherited receipts', async () => {
    await createRuntime(h.db, {
      name: 'probe-config-sequential',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ model: 'openai/gpt-5.6' }),
    })
    applyConfigPatch(h.configPath, { opencodePath: '/old-sequential-opencode' })
    const app = appWithSmoke(h, async () => CONFORMING_SMOKE)

    const probed = await reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-config-sequential/probe', {
      method: 'POST',
    })
    expect(probed.status).toBe(200)
    const before = (await getRuntime(h.db, 'probe-config-sequential'))!
    expect(before.lastProbeJson).not.toBeNull()

    const changed = await reqAs(app, DAEMON_TOKEN, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ opencodePath: '/new-sequential-opencode' }),
    })
    expect(changed.status).toBe(200)
    const after = (await getRuntime(h.db, 'probe-config-sequential'))!
    expect(after.probeFence).toBe(before.probeFence + 1)
    expect(after.lastProbeJson).toBeNull()
  })

  test('external config drift hides a persisted receipt whose effective binary no longer matches', async () => {
    await createRuntime(h.db, {
      name: 'probe-config-external',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    applyConfigPatch(h.configPath, { opencodePath: '/old-external-opencode' })
    const app = appWithSmoke(h, async () => CONFORMING_SMOKE)
    const probed = await reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-config-external/probe', {
      method: 'POST',
    })
    expect(probed.status).toBe(200)
    const before = (await getRuntime(h.db, 'probe-config-external'))!
    expect(before.lastProbeJson).not.toBeNull()

    // Bypass the HTTP coordinator to model an editor/other process replacing
    // config.json. The self-bound receipt must still fail closed on materialize.
    applyConfigPatch(h.configPath, { opencodePath: '/new-external-opencode' })
    const stored = (await getRuntime(h.db, 'probe-config-external'))!
    expect(stored.probeFence).toBe(before.probeFence)
    expect(stored.lastProbeJson).toBe(before.lastProbeJson)

    const listed = await reqAs(app, h.userToken, '/api/runtimes')
    const json = (await listed.json()) as {
      runtimes: Array<{ name: string; lastProbe: SmokeResult | null }>
    }
    expect(
      json.runtimes.find((runtime) => runtime.name === 'probe-config-external')?.lastProbe,
    ).toBeNull()
  })

  test('no-op config path PUT preserves a completed inherited receipt and fence', async () => {
    await createRuntime(h.db, {
      name: 'probe-config-noop',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ model: 'openai/gpt-5.6' }),
    })
    applyConfigPatch(h.configPath, { opencodePath: '/same-config-opencode' })
    const app = appWithSmoke(h, async () => CONFORMING_SMOKE)
    expect(
      (
        await reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-config-noop/probe', {
          method: 'POST',
        })
      ).status,
    ).toBe(200)
    const before = (await getRuntime(h.db, 'probe-config-noop'))!

    const unchanged = await reqAs(app, DAEMON_TOKEN, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ opencodePath: '/same-config-opencode' }),
    })
    expect(unchanged.status).toBe(200)
    const after = (await getRuntime(h.db, 'probe-config-noop'))!
    expect(after.probeFence).toBe(before.probeFence)
    expect(after.lastProbeJson).toBe(before.lastProbeJson)

    const listed = await reqAs(app, h.userToken, '/api/runtimes')
    const json = (await listed.json()) as {
      runtimes: Array<{ name: string; lastProbe: SmokeResult | null }>
    }
    expect(
      json.runtimes.find((runtime) => runtime.name === 'probe-config-noop')?.lastProbe,
    ).toEqual(CONFORMING_SMOKE)
  })

  test('config PUT cannot enter the final config-check to probe-cache CAS boundary', async () => {
    await createRuntime(h.db, {
      name: 'probe-final-boundary',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    await reqAs(h.app, DAEMON_TOKEN, '/api/runtimes/opencode', {
      method: 'PUT',
      body: JSON.stringify({ model: 'openai/gpt-5.6' }),
    })
    applyConfigPatch(h.configPath, { opencodePath: '/old-boundary-opencode' })
    const finalCheckReached = deferred<void>()
    const releaseCache = deferred<void>()
    const app = appWithSmoke(
      h,
      async () => CONFORMING_SMOKE,
      async () => {
        finalCheckReached.resolve()
        await releaseCache.promise
      },
    )

    const probePending = reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-final-boundary/probe', {
      method: 'POST',
    })
    await finalCheckReached.promise
    let configSettled = false
    const configPending = reqAs(app, DAEMON_TOKEN, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ opencodePath: '/new-boundary-opencode' }),
    }).then((response) => {
      configSettled = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(configSettled).toBe(false)

    releaseCache.resolve()
    expect((await probePending).status).toBe(200)
    expect((await configPending).status).toBe(200)
    const stored = (await getRuntime(h.db, 'probe-final-boundary'))!
    expect(stored.probeFence).toBe(1)
    expect(stored.lastProbeJson).toBeNull()
  })

  test('saved-runtime probe may cache across a concurrent no-op profile PUT', async () => {
    await createRuntime(h.db, {
      name: 'probe-noop-race',
      protocol: 'claude-code',
      binaryPath: '/same-binary',
    })
    const entered = deferred<void>()
    const finish = deferred<SmokeResult>()
    const app = appWithSmoke(h, async () => {
      entered.resolve()
      return finish.promise
    })

    const pending = reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-noop-race/probe', {
      method: 'POST',
    })
    await entered.promise
    const unchanged = await reqAs(app, DAEMON_TOKEN, '/api/runtimes/probe-noop-race', {
      method: 'PUT',
      body: JSON.stringify({ binaryPath: '/same-binary' }),
    })
    expect(unchanged.status).toBe(200)
    finish.resolve(CONFORMING_SMOKE)

    const fresh = await pending
    expect(fresh.status).toBe(200)
    expect((await fresh.json()) as Record<string, unknown>).toMatchObject({
      smoke: CONFORMING_SMOKE,
    })
    const stored = await getRuntime(h.db, 'probe-noop-race')
    expect(JSON.parse(stored!.lastProbeJson!)).toMatchObject({
      codec: 1,
      target: {
        id: stored!.id,
        name: 'probe-noop-race',
        probeFence: stored!.probeFence,
        resolvedBinaryPath: '/same-binary',
      },
      smoke: CONFORMING_SMOKE,
    })
  })
})
