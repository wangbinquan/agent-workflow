// RFC-370: exercise Settings through both real provider HTTP roots with one
// selected asynchronous storage. Saving must wait for storage and hot apply;
// a selected failure must never mutate the local config file.
import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import {
  mergeValidatedConfigurationPatch,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { registerConfigAppliedListener } from '@/services/configAppliedListeners'
import { createUser } from '@/services/users'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

class SelectedStorage {
  current: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    publicBaseUrl: 'https://selected-settings.example',
    mcpSurfaceEnabled: false,
  }
  gate: { entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> } | null = null
  readFailure: Error | null = null
  writeFailure: Error | null = null
  writes = 0
  readonly receivers: unknown[] = []

  async load() {
    this.receivers.push(this)
    if (this.readFailure !== null) throw this.readFailure
    return structuredClone(this.current)
  }
  async previewPatch(patch: unknown) {
    this.receivers.push(this)
    return mergeValidatedConfigurationPatch(this.current, validateConfigurationPatch(patch))
  }
  async applyPatch(patch: unknown) {
    this.receivers.push(this)
    const gate = this.gate
    gate?.entered.resolve()
    if (gate !== null) await gate.release.promise
    if (this.writeFailure !== null) throw this.writeFailure
    this.current = await this.previewPatch(patch)
    this.writes += 1
    return structuredClone(this.current)
  }
}

describeEachProviderHttpApplication(
  'RFC-370 selected Settings storage in real roots',
  {
    token: 'selected-settings-daemon',
    dbVersion: 1,
    opencodeVersion: '1.15.0',
    tempPrefix: 'aw-selected-settings-',
  },
  (scope) => {
    test('GET, PUT and discovery share the selected instance and wait for write and hot-apply ACKs', async () => {
      const storage = new SelectedStorage()
      const key = `rfc370-selected-settings-${crypto.randomUUID()}`
      const applicationConfiguration = composeApplicationConfigurationBinding({
        kind: 'selected',
        persistence: storage,
        notificationKey: key,
      })
      // Deliberately supply a different legacy query: the complete binding must
      // govern every read and Settings write when both options are present.
      const opened = await scope.open({
        applicationConfiguration,
        configuration: { read: () => structuredClone(DEFAULT_CONFIG) },
      })
      const user = await createUser(scope.harness.db, {
        username: 'selected-settings-admin',
        displayName: 'Selected Settings Admin',
        role: 'admin',
        password: 'selected-settings-fixture-password',
      })
      const session = await createSession({ db: scope.harness.db, userId: user.id })
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      }
      const configPath = join(opened.appHome, 'config.json')
      const fileBefore = readFileSync(configPath, 'utf8')
      const read = () => opened.app.request('/api/config', { headers })
      expect(await (await read()).json()).toEqual(storage.current)
      expect(await (await opened.app.request('/.well-known/mcp')).json()).toMatchObject({
        endpoint: 'https://selected-settings.example/api/mcp',
        enabled: false,
      })
      const writing = { entered: barrier(), release: barrier() }
      const applying = { entered: barrier(), release: barrier() }
      storage.gate = writing
      const applied: Config[] = []
      const unregister = registerConfigAppliedListener(key, async (config) => {
        applied.push(config)
        applying.entered.resolve()
        await applying.release.promise
      })
      let settled = false
      const pending = Promise.resolve(
        opened.app.request('/api/config', {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            publicBaseUrl: 'https://saved-settings.example',
            mcpSurfaceEnabled: true,
          }),
        }),
      ).then((response) => {
        settled = true
        return response
      })
      try {
        await Promise.race([
          writing.entered.promise,
          pending.then((response) => {
            throw new Error(`PUT returned ${response.status} before selected persistence`)
          }),
        ])
        expect(settled).toBe(false)
        expect(storage.writes).toBe(0)
        expect(applied).toEqual([])
        expect(await (await read()).json()).toEqual(storage.current)
        expect(readFileSync(configPath, 'utf8')).toBe(fileBefore)
        writing.release.resolve()
        await Promise.race([
          applying.entered.promise,
          pending.then((response) => {
            throw new Error(`PUT returned ${response.status} before hot apply`)
          }),
        ])
        expect(storage.writes).toBe(1)
        expect(applied).toEqual([storage.current])
        expect(settled).toBe(false)
        applying.release.resolve()
        const response = await pending
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(storage.current)
        expect(await (await read()).json()).toEqual(storage.current)
        expect(await (await opened.app.request('/.well-known/mcp')).json()).toMatchObject({
          endpoint: 'https://saved-settings.example/api/mcp',
          enabled: true,
        })
        expect(readFileSync(configPath, 'utf8')).toBe(fileBefore)
        expect(storage.receivers.every((receiver) => receiver === storage)).toBe(true)
      } finally {
        writing.release.resolve()
        applying.release.resolve()
        await pending
        unregister()
        storage.gate = null
      }
    })

    test('selected read/write failures stay visible and leave file settings and hot consumers unchanged', async () => {
      const storage = new SelectedStorage()
      const key = `rfc370-failed-settings-${crypto.randomUUID()}`
      const opened = await scope.open({
        applicationConfiguration: composeApplicationConfigurationBinding({
          kind: 'selected',
          persistence: storage,
          notificationKey: key,
        }),
      })
      const user = await createUser(scope.harness.db, {
        username: 'failed-settings-admin',
        displayName: 'Failed Settings Admin',
        role: 'admin',
        password: 'failed-settings-fixture-password',
      })
      const session = await createSession({ db: scope.harness.db, userId: user.id })
      const headers = {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      }
      const configPath = join(opened.appHome, 'config.json')
      const fileBefore = readFileSync(configPath, 'utf8')
      const selectedBefore = structuredClone(storage.current)
      let notifications = 0
      const unregister = registerConfigAppliedListener(key, () => {
        notifications += 1
      })
      try {
        storage.writeFailure = new Error('selected Settings write unavailable')
        const failed = await opened.app.request('/api/config', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ publicBaseUrl: 'https://never-saved.example' }),
        })
        expect(failed.status).toBe(500)
        expect(storage.current).toEqual(selectedBefore)
        expect(storage.writes).toBe(0)
        expect(notifications).toBe(0)
        expect(readFileSync(configPath, 'utf8')).toBe(fileBefore)
        storage.readFailure = new Error('selected Settings read unavailable')
        expect((await opened.app.request('/api/config', { headers })).status).toBe(500)
        expect((await opened.app.request('/.well-known/mcp')).status).toBe(500)
        expect(readFileSync(configPath, 'utf8')).toBe(fileBefore)
        storage.readFailure = null
        expect(await (await opened.app.request('/api/config', { headers })).json()).toEqual(
          selectedBefore,
        )
        expect(notifications).toBe(0)
        expect(storage.receivers.every((receiver) => receiver === storage)).toBe(true)
      } finally {
        storage.readFailure = null
        unregister()
      }
    })
  },
)
