// RFC-002 tests for the agents.new route's one-shot snapshot of Runtime
// defaults. The pure helper `applyDefaults` is the load-bearing piece — it's
// what makes "don't overwrite the user's input" hold even if the effect's
// useRef guard ever regresses.

import { describe, expect, test } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CreateAgent } from '@agent-workflow/shared'
import { applyDefaults } from '../src/routes/agents.new'

function emptyDraft(): CreateAgent {
  return {
    name: '',
    description: '',
    outputs: [],
    readonly: false,
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

describe('applyDefaults', () => {
  test('fills all five fields when draft is empty and config has them', () => {
    const next = applyDefaults(
      emptyDraft(),
      cfg({
        defaultModel: 'anthropic/sonnet',
        defaultVariant: 'thinking',
        defaultTemperature: 0.2,
        defaultSteps: 10,
        defaultMaxSteps: 50,
      }),
    )
    expect(next.model).toBe('anthropic/sonnet')
    expect(next.variant).toBe('thinking')
    expect(next.temperature).toBe(0.2)
    expect(next.steps).toBe(10)
    expect(next.maxSteps).toBe(50)
  })

  test('does not overwrite a model the user already set', () => {
    const draft = { ...emptyDraft(), model: 'user/picked' }
    const next = applyDefaults(draft, cfg({ defaultModel: 'anthropic/sonnet' }))
    expect(next.model).toBe('user/picked')
  })

  test('temperature 0 is preserved (boundary value is not "unset")', () => {
    const draft = { ...emptyDraft(), temperature: 0 }
    const next = applyDefaults(draft, cfg({ defaultTemperature: 0.7 }))
    expect(next.temperature).toBe(0)
  })

  test('leaves field undefined when config does not have a default', () => {
    const next = applyDefaults(emptyDraft(), cfg({}))
    expect(next.model).toBeUndefined()
    expect(next.variant).toBeUndefined()
    expect(next.temperature).toBeUndefined()
    expect(next.steps).toBeUndefined()
    expect(next.maxSteps).toBeUndefined()
  })

  test('only fills the subset of defaults that are present', () => {
    const next = applyDefaults(emptyDraft(), cfg({ defaultModel: 'a/b', defaultSteps: 5 }))
    expect(next.model).toBe('a/b')
    expect(next.steps).toBe(5)
    expect(next.variant).toBeUndefined()
    expect(next.temperature).toBeUndefined()
    expect(next.maxSteps).toBeUndefined()
  })

  test('returns a new object — never mutates input draft', () => {
    const draft = emptyDraft()
    const next = applyDefaults(draft, cfg({ defaultModel: 'a/b' }))
    expect(draft.model).toBeUndefined()
    expect(next).not.toBe(draft)
  })
})
