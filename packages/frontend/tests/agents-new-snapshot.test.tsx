// RFC-002 / RFC-113 tests for the agents.new route's one-shot snapshot of
// Runtime defaults. The pure helper `applyDefaults` is the load-bearing piece —
// it's what makes "don't overwrite the user's input" hold even if the effect's
// useRef guard ever regresses.
//
// RFC-113: model / variant / temperature / steps / maxSteps moved OFF the agent
// onto its RUNTIME. An agent draft now seeds exactly one Runtime default — which
// runtime it points at (config.defaultRuntime) — and `applyDefaults` must NEVER
// copy the deprecated generation params onto the draft again.

import { describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CreateAgent } from '@agent-workflow/shared'
import { applyDefaults } from '../src/routes/agents.new'

function emptyDraft(): CreateAgent {
  return {
    name: '',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  }
}

function cfg(overrides: Partial<Config>): Config {
  return { ...DEFAULT_CONFIG, ...overrides }
}

describe('applyDefaults (RFC-113: runtime selection only)', () => {
  test('fills runtime when draft has none and config has a defaultRuntime', () => {
    const next = applyDefaults(emptyDraft(), cfg({ defaultRuntime: 'opencode-opus' }))
    expect(next.runtime).toBe('opencode-opus')
  })

  test('does not overwrite a runtime the user already picked', () => {
    const draft = { ...emptyDraft(), runtime: 'my-fork' }
    const next = applyDefaults(draft, cfg({ defaultRuntime: 'opencode' }))
    expect(next.runtime).toBe('my-fork')
  })

  test('leaves runtime undefined when config has no defaultRuntime', () => {
    const next = applyDefaults(emptyDraft(), cfg({ defaultRuntime: undefined }))
    expect(next.runtime).toBeUndefined()
  })

  // The deprecated generation params must NOT be re-seeded onto an agent draft —
  // even when config still carries them (legacy configs). This locks the RFC-113
  // removal: a regression that re-copies any of them turns this red.
  test('never copies the deprecated model/variant/temperature/steps onto the draft', () => {
    const next = applyDefaults(
      emptyDraft(),
      cfg({
        defaultRuntime: 'opencode',
      }),
    )
    expect(next.runtime).toBe('opencode')
    // RFC-115: model/variant/temperature/steps/maxSteps were dropped from the
    // agent contract entirely — applyDefaults can no longer (re)introduce them.
    // The type system already forbids the keys; lock the runtime shape too so a
    // regression that stuffs a config default back onto the draft turns red.
    expect('model' in next).toBe(false)
    expect('variant' in next).toBe(false)
    expect('temperature' in next).toBe(false)
    expect('steps' in next).toBe(false)
    expect('maxSteps' in next).toBe(false)
  })

  test('returns a new object — never mutates the input draft', () => {
    const draft = emptyDraft()
    const next = applyDefaults(draft, cfg({ defaultRuntime: 'opencode' }))
    expect(draft.runtime).toBeUndefined()
    expect(next).not.toBe(draft)
  })
})
