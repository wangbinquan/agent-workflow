import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '@/config'
import { createInMemoryDb } from '@/db/client'
import { createApp } from '@/server'
import { ContainmentCoordinator } from '@/services/sandbox'
import { seedBuiltinRuntimes, updateRuntime } from '@/services/runtimeRegistry'

const TOKEN = 'c'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('RFC-233 config/effective containment mode linearization', () => {
  test('a successful config PUT updates the coordinator before responding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc233-config-mode-'))
    roots.push(root)
    const configPath = join(root, 'config.json')
    loadConfig(configPath)
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    await updateRuntime(db, 'opencode', { model: 'openai/gpt-5' })
    const coordinator = new ContainmentCoordinator({
      provider: {
        mode: 'warn',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome: root,
      },
      qualifyBwrap: async () => '/usr/bin/bwrap',
    })
    const app = createApp({
      token: TOKEN,
      configPath,
      opencodeVersion: null,
      dbVersion: 1,
      db,
      containmentCoordinator: coordinator,
    })

    const response = await app.request('/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sandboxMode: 'off' }),
    })

    expect(response.status).toBe(200)
    expect((await response.json()) as { sandboxMode: string }).toMatchObject({
      sandboxMode: 'off',
    })
    expect(loadConfig(configPath).sandboxMode).toBe('off')
    expect(coordinator.mode).toBe('off')
    expect(coordinator.policyGeneration).toBe(2)
  })

  test('a failed config write cannot change the effective coordinator generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc233-config-failure-'))
    roots.push(root)
    const pathBlocker = join(root, 'not-a-directory')
    writeFileSync(pathBlocker, 'block')
    const db = createInMemoryDb(MIGRATIONS)
    await seedBuiltinRuntimes(db)
    const coordinator = new ContainmentCoordinator({
      provider: {
        mode: 'warn',
        status: { mechanism: 'bwrap', available: true, detail: null },
        appHome: root,
      },
      qualifyBwrap: async () => '/usr/bin/bwrap',
    })
    const app = createApp({
      token: TOKEN,
      configPath: join(pathBlocker, 'config.json'),
      opencodeVersion: null,
      dbVersion: 1,
      db,
      containmentCoordinator: coordinator,
    })

    const response = await app.request('/api/config', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sandboxMode: 'off' }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(coordinator.mode).toBe('warn')
    expect(coordinator.policyGeneration).toBe(1)
  })
})
