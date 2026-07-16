// RFC-201 PR-A/T2 — Settings panels are active-only mounted, so their Config
// drafts must live in one route-owned pure registry. These regression locks
// prevent section navigation, refetches, and late GETs from reconstructing or
// silently clearing a user's draft.

import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  SETTINGS_CONFIG_SCOPE_IDS,
  SETTINGS_CONFIG_SCOPE_KEYS,
  aggregateSettingsDraftRegistry,
  createSettingsDraftRegistry,
  getSettingsDraftScope,
  rebaseSettingsDraftRegistryGeneration,
  settingsDraftRegistryReducer,
} from '@/lib/settings-drafts'

const limitsScope = SETTINGS_CONFIG_SCOPE_IDS.limits
const networkScope = SETTINGS_CONFIG_SCOPE_IDS.network
const appearanceScope = SETTINGS_CONFIG_SCOPE_IDS.appearance

function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides }
}

describe('RFC-201 Settings draft registry', () => {
  test('enumerates only Config-backed sections and owns exact minimal-patch keys', () => {
    expect(Object.keys(SETTINGS_CONFIG_SCOPE_IDS)).toEqual([
      'systemAgents',
      'limits',
      'recovery',
      'gc',
      'network',
      'appearance',
      'rendering',
    ])
    expect(Object.keys(SETTINGS_CONFIG_SCOPE_IDS)).not.toContain('runtime')
    expect(Object.keys(SETTINGS_CONFIG_SCOPE_IDS)).not.toContain('authentication')
    expect(SETTINGS_CONFIG_SCOPE_KEYS.systemAgents).toEqual([
      'commitPushRuntime',
      'commitPushModel',
      'commitPushMaxRepairRetries',
      'commitPushDiffMaxBytes',
      'commitPushLang',
      'memoryDistillRuntime',
      'memoryDistillModel',
      'memoryDistillLang',
      'mergeAgentRuntime',
      'mergeAgentModel',
    ])
  })

  test('Limits -> another section -> Limits keeps the route-owned draft', () => {
    let registry = createSettingsDraftRegistry(config(), { generation: 7 })

    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 12,
      },
    })
    const limitsRevision = getSettingsDraftScope(registry, limitsScope).revision

    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: networkScope,
      draft: {
        ...getSettingsDraftScope(registry, networkScope).draft,
        bindHost: '0.0.0.0',
      },
    })

    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      draft: { maxConcurrentNodes: 12 },
      revision: limitsRevision,
      dirty: true,
    })
    expect(aggregateSettingsDraftRegistry(registry)).toMatchObject({
      dirty: true,
      valid: false,
    })
  })

  test('foreign Config read preserves a dirty projection and advances clean sections', () => {
    const initial = config({ maxConcurrentNodes: 4, theme: 'system' })
    let registry = createSettingsDraftRegistry(initial, { generation: 2, issuedEpoch: 1 })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 8,
      },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'validity',
      scope: limitsScope,
      validity: 'valid',
    })

    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-read',
      receipt: {
        type: 'read',
        generation: 2,
        issuedEpoch: 2,
        config: config({ maxConcurrentNodes: 6, theme: 'dark' }),
      },
    })

    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 4 },
      draft: { maxConcurrentNodes: 8 },
      staleRemote: { maxConcurrentNodes: 6 },
      dirty: true,
    })
    expect(getSettingsDraftScope(registry, appearanceScope)).toMatchObject({
      baseline: { theme: 'dark' },
      draft: { theme: 'dark' },
      dirty: false,
    })
    expect(aggregateSettingsDraftRegistry(registry).stale).toBe(true)
  })

  test('matching write receipt fences late GET(A), then a newer GET(C) converges', () => {
    let registry = createSettingsDraftRegistry(config({ maxConcurrentNodes: 4 }), {
      generation: 1,
      issuedEpoch: 1,
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 8,
      },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'validity',
      scope: limitsScope,
      validity: 'valid',
    })
    const submittedRevision = getSettingsDraftScope(registry, limitsScope).revision
    registry = settingsDraftRegistryReducer(registry, {
      type: 'begin-submit',
      scope: limitsScope,
      requestId: 'limits-save-1',
      submittedRevision,
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'submit-success',
      scope: limitsScope,
      requestId: 'limits-save-1',
      submittedRevision,
      receipt: {
        generation: 1,
        writeEpoch: 1,
        ignoreReadsThroughEpoch: 4,
        config: config({ maxConcurrentNodes: 8 }),
      },
    })

    const afterWrite = registry
    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-read',
      receipt: {
        type: 'read',
        generation: 1,
        issuedEpoch: 4,
        config: config({ maxConcurrentNodes: 4 }),
      },
    })
    expect(registry).toBe(afterWrite)
    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 8 },
      draft: { maxConcurrentNodes: 8 },
      dirty: false,
    })

    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-read',
      receipt: {
        type: 'read',
        generation: 1,
        issuedEpoch: 5,
        config: config({ maxConcurrentNodes: 10 }),
      },
    })
    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 10 },
      draft: { maxConcurrentNodes: 10 },
      dirty: false,
    })
  })

  test('an external Config writer publishes its full receipt and read floor to every scope', () => {
    let registry = createSettingsDraftRegistry(
      config({ maxConcurrentNodes: 4, language: 'zh-CN' }),
      { generation: 3, issuedEpoch: 1 },
    )
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 8,
      },
    })

    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-write',
      receipt: {
        generation: 3,
        writeEpoch: 1,
        ignoreReadsThroughEpoch: 6,
        config: config({ maxConcurrentNodes: 4, language: 'en-US' }),
      },
    })

    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 4 },
      draft: { maxConcurrentNodes: 8 },
      dirty: true,
      ignoreReadsThroughEpoch: 6,
    })
    expect(getSettingsDraftScope(registry, appearanceScope)).toMatchObject({
      baseline: { language: 'en-US' },
      draft: { language: 'en-US' },
      dirty: false,
      ignoreReadsThroughEpoch: 6,
    })

    const afterWrite = registry
    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-read',
      receipt: {
        type: 'read',
        generation: 3,
        issuedEpoch: 6,
        config: config({ language: 'zh-CN' }),
      },
    })
    expect(registry).toBe(afterWrite)
  })

  test('a newer edit made during submit remains dirty after the older exact receipt', () => {
    let registry = createSettingsDraftRegistry(config({ maxConcurrentNodes: 4 }))
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 8,
      },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'validity',
      scope: limitsScope,
      validity: 'valid',
    })
    const submittedRevision = getSettingsDraftScope(registry, limitsScope).revision
    registry = settingsDraftRegistryReducer(registry, {
      type: 'begin-submit',
      scope: limitsScope,
      requestId: 'limits-save-2',
      submittedRevision,
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 12,
      },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'submit-success',
      scope: limitsScope,
      requestId: 'limits-save-2',
      submittedRevision,
      receipt: {
        generation: 1,
        writeEpoch: 1,
        ignoreReadsThroughEpoch: 3,
        config: config({ maxConcurrentNodes: 8 }),
      },
    })

    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 8 },
      draft: { maxConcurrentNodes: 12 },
      revision: 2,
      validity: 'unknown',
      dirty: true,
    })
  })

  test('W2 consumed before W1 mutation callback cannot let W1 roll projections back', () => {
    let registry = createSettingsDraftRegistry(config({ maxConcurrentNodes: 4, theme: 'system' }))
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: {
        ...getSettingsDraftScope(registry, limitsScope).draft,
        maxConcurrentNodes: 8,
      },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'validity',
      scope: limitsScope,
      validity: 'valid',
    })
    const submittedRevision = getSettingsDraftScope(registry, limitsScope).revision
    registry = settingsDraftRegistryReducer(registry, {
      type: 'begin-submit',
      scope: limitsScope,
      requestId: 'limits-w1',
      submittedRevision,
    })

    const w1 = {
      generation: 1,
      writeEpoch: 1,
      ignoreReadsThroughEpoch: 2,
      config: config({ maxConcurrentNodes: 8, theme: 'system' }),
    }
    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-write',
      receipt: w1,
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-write',
      receipt: {
        generation: 1,
        writeEpoch: 2,
        ignoreReadsThroughEpoch: 3,
        config: config({ maxConcurrentNodes: 8, theme: 'dark' }),
      },
    })

    // React Query's W1 onSuccess runs late. It may settle W1's own busy flag,
    // but every projection must remain on the already-consumed W2 snapshot.
    registry = settingsDraftRegistryReducer(registry, {
      type: 'submit-success',
      scope: limitsScope,
      requestId: 'limits-w1',
      submittedRevision,
      receipt: w1,
    })

    expect(registry.lastAcceptedWriteEpoch).toBe(2)
    expect(registry.latestAuthoritativeConfig.theme).toBe('dark')
    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 8 },
      draft: { maxConcurrentNodes: 8 },
      dirty: false,
    })
    expect(getSettingsDraftScope(registry, limitsScope).inFlight).toBeUndefined()
    expect(getSettingsDraftScope(registry, appearanceScope)).toMatchObject({
      baseline: { theme: 'dark' },
      draft: { theme: 'dark' },
      dirty: false,
    })
  })

  test('token rebase settles an exact write already accepted before its mutation callback', () => {
    let registry = createSettingsDraftRegistry(config({ maxConcurrentNodes: 4 }), {
      generation: 1,
      resourceIdentity: 'daemon:A',
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'edit',
      scope: limitsScope,
      draft: { ...getSettingsDraftScope(registry, limitsScope).draft, maxConcurrentNodes: 8 },
    })
    registry = settingsDraftRegistryReducer(registry, {
      type: 'validity',
      scope: limitsScope,
      validity: 'valid',
    })
    const submittedRevision = getSettingsDraftScope(registry, limitsScope).revision
    registry = settingsDraftRegistryReducer(registry, {
      type: 'begin-submit',
      scope: limitsScope,
      requestId: 'limits-token-rotate',
      submittedRevision,
    })
    const acceptedBeforeRotation = {
      generation: 1,
      writeEpoch: 7,
      ignoreReadsThroughEpoch: 3,
      config: config({ maxConcurrentNodes: 8 }),
    }

    registry = settingsDraftRegistryReducer(registry, {
      type: 'config-write',
      receipt: acceptedBeforeRotation,
    })
    registry = rebaseSettingsDraftRegistryGeneration(registry, 2)
    registry = settingsDraftRegistryReducer(registry, {
      type: 'submit-success',
      scope: limitsScope,
      requestId: 'limits-token-rotate',
      submittedRevision,
      receipt: acceptedBeforeRotation,
    })

    expect(registry).toMatchObject({
      generation: 2,
      resourceIdentity: 'daemon:A',
      lastAcceptedWriteEpoch: 7,
    })
    expect(getSettingsDraftScope(registry, limitsScope)).toMatchObject({
      baseline: { maxConcurrentNodes: 8 },
      draft: { maxConcurrentNodes: 8 },
      dirty: false,
    })
    expect(getSettingsDraftScope(registry, limitsScope).inFlight).toBeUndefined()
  })
})
