// RFC-117 — resolveInternalAgentRuntime priority for internal framework agents
// (distiller / commit-push), which pick a runtime via a per-feature config field
// rather than an agents-table row. Priority: per-feature profile NAME > deprecated
// per-feature model (transition: opencode + that model) > global defaultRuntime >
// opencode. Fall-safe — a dangling name can't brick the background job / commit
// (mirrors resolveRuntimeByName, unlike the fail-loud validateRuntimeReference).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createRuntime, resolveInternalAgentRuntime } from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
function freshDb(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

describe('resolveInternalAgentRuntime (RFC-117)', () => {
  test('runtimeName wins: resolves the named profile (protocol + binary + model)', async () => {
    const db = freshDb()
    await createRuntime(db, {
      name: 'oc-haiku',
      protocol: 'opencode',
      binaryPath: '/usr/bin/oc-haiku',
      model: 'anthropic/haiku',
    })
    const rt = await resolveInternalAgentRuntime(db, {
      runtimeName: 'oc-haiku',
      deprecatedModel: 'ignored/model',
      defaultRuntime: 'opencode',
    })
    expect(rt.name).toBe('oc-haiku')
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBe('/usr/bin/oc-haiku')
    expect(rt.model).toBe('anthropic/haiku')
  })

  test('no runtimeName + deprecated model → opencode + that model (transition fallback)', async () => {
    const db = freshDb()
    const rt = await resolveInternalAgentRuntime(db, {
      runtimeName: null,
      deprecatedModel: 'legacy/model',
      defaultRuntime: 'opencode',
    })
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBeNull()
    expect(rt.model).toBe('legacy/model')
  })

  test('empty runtimeName is treated as unset → falls through to deprecated model', async () => {
    const db = freshDb()
    const rt = await resolveInternalAgentRuntime(db, {
      runtimeName: '',
      deprecatedModel: 'legacy/model',
    })
    expect(rt.protocol).toBe('opencode')
    expect(rt.model).toBe('legacy/model')
  })

  test('no runtimeName + no model → inherits the defaultRuntime profile', async () => {
    const db = freshDb()
    await createRuntime(db, {
      name: 'cc-default',
      protocol: 'claude-code',
      binaryPath: '/opt/cc',
      model: 'claude-sonnet',
    })
    const rt = await resolveInternalAgentRuntime(db, {
      runtimeName: null,
      deprecatedModel: null,
      defaultRuntime: 'cc-default',
    })
    expect(rt.name).toBe('cc-default')
    expect(rt.protocol).toBe('claude-code')
    expect(rt.model).toBe('claude-sonnet')
  })

  test('nothing set → opencode fall-safe (null model = the binary default)', async () => {
    const db = freshDb()
    const rt = await resolveInternalAgentRuntime(db, {})
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBeNull()
    expect(rt.model).toBeNull()
  })

  test('dangling runtimeName fall-safe to opencode (does not brick the job)', async () => {
    const db = freshDb()
    const rt = await resolveInternalAgentRuntime(db, { runtimeName: 'does-not-exist' })
    expect(rt.protocol).toBe('opencode')
  })
})
