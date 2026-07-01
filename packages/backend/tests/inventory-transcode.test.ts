// RFC-029 T3: transcoder.ts — field mapping for opencode SDK shapes.
// Fixtures mirror real opencode 1.15 SDK response shapes. If opencode
// changes a field name and breaks the mapping, this test goes red — the
// dump plugin's JS twin is locked to the same logic via
// `inventory-dump-twin-parity.test.ts`.

import { describe, expect, test } from 'bun:test'
import {
  transcodeAgent,
  transcodeMcp,
  transcodePluginOrigin,
  transcodeSkill,
} from '../src/opencode-plugin/transcoder'

describe('transcodeAgent', () => {
  test('extracts model.providerID / model.modelID and source.type', () => {
    expect(
      transcodeAgent({
        name: 'reviewer',
        mode: 'primary',
        model: { providerID: 'anthropic', modelID: 'claude-opus-4-7' },
        source: { type: 'inline', path: null },
        permission: { edit: 'allow', bash: 'allow' },
      }),
    ).toEqual({
      name: 'reviewer',
      mode: 'primary',
      modelProviderId: 'anthropic',
      modelId: 'claude-opus-4-7',
      source: 'inline',
    })
  })

  test('falls back to (unnamed)/unknown for missing fields', () => {
    expect(transcodeAgent({})).toEqual({
      name: '(unnamed)',
      mode: 'unknown',
      modelProviderId: null,
      modelId: null,
      source: 'unknown',
    })
  })
})

describe('transcodeSkill', () => {
  test('takes source.type and source.path from nested source', () => {
    expect(
      transcodeSkill({
        name: 'foo',
        description: 'do stuff',
        source: { type: 'managed', path: '/x/foo' },
      }),
    ).toEqual({ name: 'foo', source: 'managed', path: '/x/foo', description: 'do stuff' })
  })

  test('description nullable; path nullable', () => {
    expect(transcodeSkill({ name: 's' })).toEqual({
      name: 's',
      source: 'unknown',
      path: null,
      description: null,
    })
  })
})

describe('transcodeMcp', () => {
  test('reads config.type, status, prefers error → url → hint for hint field', () => {
    expect(
      transcodeMcp('memcache', {
        config: { type: 'local' },
        status: 'connected',
      }),
    ).toEqual({ name: 'memcache', type: 'local', status: 'connected', hint: null })

    expect(
      transcodeMcp('github', {
        config: { type: 'remote' },
        status: 'needs_auth',
        error: 'token missing',
        url: 'https://github.example/sse',
      }),
    ).toEqual({ name: 'github', type: 'remote', status: 'needs_auth', hint: 'token missing' })

    expect(
      transcodeMcp('jira', {
        config: { type: 'remote' },
        status: 'connected',
        url: 'https://jira.example',
      }),
    ).toEqual({ name: 'jira', type: 'remote', status: 'connected', hint: 'https://jira.example' })
  })

  test('preserves unknown status strings verbatim (forward-compat)', () => {
    expect(transcodeMcp('x', { status: 'brand-new' }).status).toBe('brand-new')
  })
})

describe('transcodePluginOrigin', () => {
  test('string spec passes through; tuple spec uses first element', () => {
    expect(transcodePluginOrigin({ spec: 'file:///tmp/a.mjs', source: 'inline' })).toEqual({
      specifier: 'file:///tmp/a.mjs',
      source: 'inline',
    })
    expect(
      transcodePluginOrigin({ spec: ['file:///tmp/b.mjs', { foo: 1 }], source: 'global' }),
    ).toEqual({ specifier: 'file:///tmp/b.mjs', source: 'global' })
  })

  test('non-string non-array spec → stringified', () => {
    expect(transcodePluginOrigin({ spec: { weird: true }, source: 'project' })).toEqual({
      specifier: '{"weird":true}',
      source: 'project',
    })
  })

  test('missing spec → (unknown)', () => {
    expect(transcodePluginOrigin({ source: 'inline' })).toEqual({
      specifier: '(unknown)',
      source: 'inline',
    })
  })
})
