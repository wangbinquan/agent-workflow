// RFC-370: runtime management in both real HTTP roots reads the selected live
// configuration and waits for its ACK before projecting profiles or probing.
// Only diagnostic execution is injected; all registry/HTTP behavior is real.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { createUser } from '@/services/users'
import type { SmokeOptions, SmokeResult } from '@/services/runtimeSmoke'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
function held() {
  return { entered: barrier(), release: barrier() }
}
class SelectedRuntimeStorage {
  current: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    defaultRuntime: 'claude-code',
    opencodePath: 'selected-opencode',
    claudeCodePath: 'selected-claude',
  }
  gate: ReturnType<typeof held> | null = null
  failure: Error | null = null
  readonly receivers: unknown[] = []
  async load() {
    this.receivers.push(this)
    const gate = this.gate
    gate?.entered.resolve()
    if (gate !== null) await gate.release.promise
    if (this.failure !== null) throw this.failure
    return structuredClone(this.current)
  }
  async previewPatch(patch: unknown) {
    return mergeValidatedConfigurationPatch(this.current, validateConfigurationPatch(patch))
  }
  async applyPatch(patch: unknown) {
    this.current = await this.previewPatch(patch)
    return structuredClone(this.current)
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected runtime configuration in real roots',
  {
    token: 'selected-runtime-daemon',
    dbVersion: 1,
    opencodeVersion: '1.15.0',
    tempPrefix: 'aw-selected-runtime-',
  },
  (scope) => {
    async function setup() {
      const storage = new SelectedRuntimeStorage()
      await composeRuntimeRegistryOperations(scope.harness.db).seedBuiltinRuntimes()
      const probes: SmokeOptions[] = []
      const opened = await scope.open({
        applicationConfiguration: composeApplicationConfigurationBinding({
          kind: 'selected',
          persistence: storage,
          notificationKey: `rfc370-selected-runtime-${crypto.randomUUID()}`,
        }),
        // A legacy query and file deliberately disagree with the complete binding.
        configuration: { read: () => structuredClone(DEFAULT_CONFIG) },
        config: {
          defaultRuntime: 'opencode',
          opencodePath: 'file-opencode',
          claudeCodePath: 'file-claude',
        },
        runtimeDiagnosticTestDependencies: {
          async smokeRuntime(input): Promise<SmokeResult> {
            probes.push(input)
            return {
              outcome: 'model-call-failed',
              conforms: false,
              detail: 'fixture model unavailable',
              sawNonce: false,
              sawEnvelope: false,
              exitCode: 1,
            }
          },
        },
      })
      const user = await createUser(scope.harness.db, {
        username: 'selected-runtime-admin',
        displayName: 'Selected Runtime Admin',
        role: 'admin',
        password: 'selected-runtime-fixture-password',
      })
      const session = await createSession({ db: scope.harness.db, userId: user.id })
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      }
      const file = join(opened.appHome, 'config.json')
      const fileBefore = readFileSync(file, 'utf8')
      return { storage, probes, opened, headers, file, fileBefore }
    }
    test('profile default waits for selected reads and reflects later changes without touching the file', async () => {
      const f = await setup()
      const gate = held()
      f.storage.gate = gate
      let settled = false
      const pending = Promise.resolve(
        f.opened.app.request('/api/runtimes', { headers: f.headers }),
      ).then((response) => {
        settled = true
        return response
      })
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then((response) => {
            throw new Error(`runtime list returned ${response.status} before selected read`)
          }),
        ])
        expect(settled).toBe(false)
        gate.release.resolve()
        const response = await pending
        expect(response.status).toBe(200)
        const body = (await response.json()) as { runtimes: { name: string; isDefault: boolean }[] }
        expect(body.runtimes.filter((row) => row.isDefault).map((row) => row.name)).toEqual([
          'claude-code',
        ])
        f.storage.gate = null
        f.storage.current = { ...f.storage.current, defaultRuntime: 'opencode' }
        const changed = await f.opened.app.request('/api/runtimes', { headers: f.headers })
        expect(changed.status).toBe(200)
        const next = (await changed.json()) as { runtimes: { name: string; isDefault: boolean }[] }
        expect(next.runtimes.filter((row) => row.isDefault).map((row) => row.name)).toEqual([
          'opencode',
        ])
        expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
        expect(f.storage.receivers.every((receiver) => receiver === f.storage)).toBe(true)
        expect(f.probes).toEqual([])
      } finally {
        gate.release.resolve()
        f.storage.gate = null
        await pending
      }
    })
    test('diagnostic reads wait for the selected ACK and pass the live binary configuration', async () => {
      const f = await setup()
      const gate = held()
      f.storage.gate = gate
      const pending = Promise.resolve(
        f.opened.app.request('/api/runtimes/probe', {
          method: 'POST',
          headers: f.headers,
          body: JSON.stringify({ protocol: 'opencode', binaryPath: 'diagnostic-binary' }),
        }),
      )
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then((response) => {
            throw new Error(`diagnostic returned ${response.status} before selected read`)
          }),
        ])
        expect(f.probes).toEqual([])
        f.storage.current = { ...f.storage.current, opencodePath: 'latest-selected-opencode' }
        gate.release.resolve()
        const response = await pending
        expect(response.status).toBe(200)
        expect(f.probes).toHaveLength(1)
        expect(f.probes[0]).toMatchObject({
          binaryPath: 'diagnostic-binary',
          config: { opencodePath: 'latest-selected-opencode', claudeCodePath: 'selected-claude' },
        })
        expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
      } finally {
        gate.release.resolve()
        f.storage.gate = null
        await pending
      }
    })
    test('selected configuration rejection remains visible without a file fallback or diagnostic effect', async () => {
      const f = await setup()
      f.storage.failure = new Error('selected runtime configuration unavailable')
      const list = await f.opened.app.request('/api/runtimes', { headers: f.headers })
      expect(list.status).toBe(500)
      const probe = await f.opened.app.request('/api/runtimes/probe', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ protocol: 'opencode', binaryPath: 'unused-diagnostic-binary' }),
      })
      expect(probe.status).toBe(500)
      expect(f.probes).toEqual([])
      expect(readFileSync(f.file, 'utf8')).toBe(f.fileBefore)
    })
  },
)
