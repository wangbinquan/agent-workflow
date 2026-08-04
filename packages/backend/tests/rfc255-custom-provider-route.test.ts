// RFC-255 — PUT /api/config end to end for custom providers.
//
// Why this test exists: a regression found during the implementation gate.
// `mergePatch` carries the STORED provider entries (sealed keys) into the
// merged config, so running the save gate on every PUT made an unrelated
// settings change — a log level, a theme — re-seal each credential. The double
// sealed value then unsealed to ciphertext, the gateway rejected every request,
// and nothing on the platform pointed back at the config write that caused it.
// The route now runs the gate only when the patch actually carries the key.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { runtimes } from '../src/db/schema'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { saveConfigRaw } from '../src/config'
import {
  CUSTOM_PROVIDER_API_KEY_MASK,
  CUSTOM_PROVIDER_NPM,
  DEFAULT_CONFIG,
  type Config,
} from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 11))
const PLAINTEXT = 'sk-gateway-live'

let dir: string
let configPath: string
let app: Hono

const entry = {
  id: 'mygw',
  name: 'Internal Gateway',
  npm: CUSTOM_PROVIDER_NPM,
  baseURL: 'https://gw.internal.example/v1',
  apiKey: secretBox.seal(PLAINTEXT),
  models: [{ id: 'deepseek-v3' }],
  enabled: true,
}

function storedConfig(): Config {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Config
}

async function put(body: unknown): Promise<Response> {
  return app.request('/api/config', {
    method: 'PUT',
    headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rfc255-route-'))
  configPath = join(dir, 'config.json')
  saveConfigRaw(configPath, { ...DEFAULT_CONFIG, customProviders: [entry] } as Config)
  const db = createInMemoryDb(MIGRATIONS)
  // The route re-validates every internal agent's effective runtime on each
  // PUT. A migrations-only DB has no runtime rows at all, which fails as
  // `model-unresolved` — an unrelated 422 that would mask what these tests are
  // actually about.
  await db.insert(runtimes).values({
    id: 'rt-rfc255',
    name: 'opencode',
    protocol: 'opencode',
    binaryPath: '/nonexistent-rfc255-binary',
    model: 'anthropic/opus',
  })
  app = createApp({
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('RFC-255 PUT /api/config', () => {
  test('an unrelated settings change leaves the credential byte-identical', async () => {
    const before = storedConfig().customProviders[0]!.apiKey
    const res = await put({ logLevel: 'debug' })
    expect(res.status).toBe(200)
    const after = storedConfig().customProviders[0]!.apiKey
    expect(after).toBe(before)
    // The decisive assertion: still ONE layer of sealing.
    expect(secretBox.unseal(after!)).toBe(PLAINTEXT)
  })

  test('GET and PUT responses both mask the stored credential', async () => {
    const getRes = await app.request('/api/config', {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    const getBody = (await getRes.json()) as Config
    expect(getBody.customProviders[0]?.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)

    const putRes = await put({ logLevel: 'info' })
    const putBody = (await putRes.json()) as Config
    expect(putBody.customProviders[0]?.apiKey).toBe(CUSTOM_PROVIDER_API_KEY_MASK)
    expect(JSON.stringify(putBody)).not.toContain(PLAINTEXT)
    expect(JSON.stringify(putBody)).not.toContain(entry.apiKey)
  })

  test('a masked round trip edits the endpoint and keeps the credential', async () => {
    const res = await put({
      customProviders: [
        {
          ...entry,
          apiKey: CUSTOM_PROVIDER_API_KEY_MASK,
          baseURL: 'https://gw.internal.example/v2',
        },
      ],
    })
    expect(res.status).toBe(200)
    const saved = storedConfig().customProviders[0]!
    expect(saved.baseURL).toBe('https://gw.internal.example/v2')
    expect(secretBox.unseal(saved.apiKey!)).toBe(PLAINTEXT)
  })

  test('a new key is sealed before it reaches disk', async () => {
    const res = await put({ customProviders: [{ ...entry, apiKey: 'sk-rotated' }] })
    expect(res.status).toBe(200)
    const onDisk = readFileSync(configPath, 'utf-8')
    expect(onDisk).not.toContain('sk-rotated')
    expect(secretBox.unseal(storedConfig().customProviders[0]!.apiKey!)).toBe('sk-rotated')
  })

  test('a reserved catalog id is refused with a stable code', async () => {
    const res = await put({ customProviders: [{ ...entry, id: 'anthropic', apiKey: 'sk-x' }] })
    // 422 is this codebase's ValidationError status, not 400.
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('config-custom-provider-id-reserved')
    // The stored config is untouched by a rejected write.
    expect(storedConfig().customProviders[0]?.id).toBe('mygw')
  })
})
