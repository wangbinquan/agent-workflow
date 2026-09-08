// RFC-117 — resolveInternalAgentRuntime priority for internal framework agents
// (distiller / commit-push), which pick a runtime via a per-feature config field
// rather than an agents-table row. Priority: per-feature profile NAME > deprecated
// per-feature model (transition: opencode + that model) > global defaultRuntime >
// opencode. Fall-safe — a dangling name can't brick the background job / commit
// (mirrors resolveRuntimeByName, unlike the fail-loud validateRuntimeReference).

import { expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { createRuntime, resolveInternalAgentRuntime } from '../src/services/runtimeRegistry'
import { DrizzleRuntimeRegistryPersistence } from '../src/platform/runtime-registry/infrastructure/runtimeRegistryPersistence'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('resolveInternalAgentRuntime (RFC-117)', (harness) => {
  test('runtimeName wins: resolves the named profile (protocol + binary + model)', async () => {
    const db = harness.db
    await createRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      name: 'oc-haiku',
      protocol: 'opencode',
      binaryPath: canonicalBinaryPath('oc-haiku'),
      model: 'anthropic/haiku',
    })
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      runtimeName: 'oc-haiku',
      deprecatedModel: 'ignored/model',
      defaultRuntime: 'opencode',
    })
    expect(rt.name).toBe('oc-haiku')
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBe(canonicalBinaryPath('oc-haiku'))
    expect(rt.model).toBe('anthropic/haiku')
  })

  test('no runtimeName + deprecated model → opencode + that model (transition fallback)', async () => {
    const db = harness.db
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      runtimeName: null,
      deprecatedModel: 'legacy/model',
      defaultRuntime: 'opencode',
    })
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBeNull()
    expect(rt.model).toBe('legacy/model')
  })

  test('empty runtimeName is treated as unset → falls through to deprecated model', async () => {
    const db = harness.db
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      runtimeName: '',
      deprecatedModel: 'legacy/model',
    })
    expect(rt.protocol).toBe('opencode')
    expect(rt.model).toBe('legacy/model')
  })

  test('no runtimeName + no model → inherits the defaultRuntime profile', async () => {
    const db = harness.db
    await createRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      name: 'cc-default',
      protocol: 'claude-code',
      binaryPath: canonicalBinaryPath('cc'),
      model: 'claude-sonnet',
    })
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      runtimeName: null,
      deprecatedModel: null,
      defaultRuntime: 'cc-default',
    })
    expect(rt.name).toBe('cc-default')
    expect(rt.protocol).toBe('claude-code')
    expect(rt.model).toBe('claude-sonnet')
  })

  test('nothing set → opencode fall-safe (null model = the binary default)', async () => {
    const db = harness.db
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {})
    expect(rt.protocol).toBe('opencode')
    expect(rt.binaryPath).toBeNull()
    expect(rt.model).toBeNull()
  })

  test('dangling runtimeName fall-safe to opencode (does not brick the job)', async () => {
    const db = harness.db
    const rt = await resolveInternalAgentRuntime(new DrizzleRuntimeRegistryPersistence(db), {
      runtimeName: 'does-not-exist',
    })
    expect(rt.protocol).toBe('opencode')
  })
})
