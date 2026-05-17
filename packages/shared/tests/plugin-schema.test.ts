// RFC-031 T1: shared plugin schema contract tests.
//
// Pins the wire format the API, UI and runner agree on. Notably:
//   - `spec` is always a single string in DB storage; the opencode Spec tuple
//     `[spec, options]` form lives only in inject-time output, NOT in this
//     schema. Locking that here prevents the DB column shape from drifting.
//   - `options` is a plain Record<string, unknown>.
//   - `cachedPath` is required in the response shape (filled by the installer
//     on save); we never persist a row without a resolved entry.
//   - sourceKind enum locked to npm/file/git (no `github:` etc — those are
//     normalised to `git` during install).
//   - Agent.plugins default `[]`; name regex matches PluginNameSchema.

import { describe, expect, test } from 'bun:test'
import {
  AgentSchema,
  CreateAgentSchema,
  CreatePluginSchema,
  PLUGIN_NAME_RE,
  PluginNameSchema,
  PluginOptionsSchema,
  PluginSchema,
  PluginSourceKindSchema,
  PluginSpecSchema,
  PluginUpdateCheckSchema,
  RenamePluginSchema,
  UpdatePluginSchema,
} from '../src'

describe('PluginNameSchema', () => {
  test('accepts lowercase alphanumerics with dashes / underscores', () => {
    for (const ok of ['a', 'dd-trace', 'opencode_changelog', 'plug-1', 'x0']) {
      expect(PluginNameSchema.safeParse(ok).success).toBe(true)
    }
  })

  test('rejects leading dash / uppercase / spaces / path traversal', () => {
    for (const bad of ['-foo', '_bar', 'A', 'foo bar', 'foo/bar', '..', '', 'X'.repeat(65)]) {
      expect(PluginNameSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('regex is exported and matches schema behavior', () => {
    expect(PLUGIN_NAME_RE.test('valid-name_1')).toBe(true)
    expect(PLUGIN_NAME_RE.test('Invalid')).toBe(false)
  })
})

describe('PluginSpecSchema', () => {
  test('accepts npm / file / git URL / relative path / github shorthand specs', () => {
    for (const ok of [
      'my-plugin@1.2.3',
      '@scope/pkg@latest',
      'file:///abs/path/to/plugin.ts',
      './plugin.ts',
      '../foo/bar.ts',
      '/abs/path',
      'github:org/repo',
      'git+https://github.com/org/repo.git#v1.0.0',
      'git+ssh://git@gitlab.corp/team/oc-plugin.git#v0.3.0',
    ]) {
      expect(PluginSpecSchema.safeParse(ok).success).toBe(true)
    }
  })

  test('rejects empty / too long spec', () => {
    expect(PluginSpecSchema.safeParse('').success).toBe(false)
    expect(PluginSpecSchema.safeParse('x'.repeat(513)).success).toBe(false)
  })
})

describe('PluginOptionsSchema', () => {
  test('accepts plain record / empty object', () => {
    expect(PluginOptionsSchema.safeParse({}).success).toBe(true)
    expect(PluginOptionsSchema.safeParse({ apiKey: 'x', nested: { y: 1 } }).success).toBe(true)
  })

  test('rejects non-object payloads', () => {
    for (const bad of [null, undefined, 'foo', 42, ['a']]) {
      expect(PluginOptionsSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('PluginSourceKindSchema', () => {
  test('only enumerates npm / file / git', () => {
    for (const ok of ['npm', 'file', 'git']) {
      expect(PluginSourceKindSchema.safeParse(ok).success).toBe(true)
    }
    for (const bad of ['github', 'gitlab', 'http', '', 'NPM']) {
      expect(PluginSourceKindSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('PluginSchema (response shape)', () => {
  const base = {
    id: 'p_01',
    name: 'dd-trace',
    spec: '@mycorp/opencode-dd-trace@2.4.1',
    options: {},
    description: '',
    enabled: true,
    sourceKind: 'npm' as const,
    cachedPath: '/Users/x/.agent-workflow/plugins/p_01/node_modules/@mycorp/opencode-dd-trace',
    resolvedVersion: '2.4.1',
    installedAt: 1_700_000_000_000,
    schemaVersion: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }

  test('happy path round-trips', () => {
    expect(PluginSchema.safeParse(base).success).toBe(true)
  })

  test('cachedPath is required (cannot persist unresolved plugin)', () => {
    const r = PluginSchema.safeParse({ ...base, cachedPath: '' })
    expect(r.success).toBe(false)
  })

  test('resolvedVersion may be null but not missing', () => {
    expect(PluginSchema.safeParse({ ...base, resolvedVersion: null }).success).toBe(true)
    const { resolvedVersion: _drop, ...withoutVersion } = base
    expect(PluginSchema.safeParse(withoutVersion).success).toBe(false)
  })

  test('spec must be a string — tuple form is NOT a DB storage shape', () => {
    // Regression anchor for design §2.3: opencode's [spec, options] tuple is
    // an inject-time artifact built in runner.buildInlineConfig. If the DB
    // schema ever accepts tuples here, that boundary has been crossed and
    // multiple invariants (rename refactors, JSON validation) break.
    const r = PluginSchema.safeParse({ ...base, spec: ['foo', { a: 1 }] as unknown as string })
    expect(r.success).toBe(false)
  })
})

describe('CreatePluginSchema', () => {
  test('options defaults to {}', () => {
    const r = CreatePluginSchema.parse({ name: 'p1', spec: 'x@1' })
    expect(r.options).toEqual({})
    expect(r.enabled).toBe(true)
    expect(r.description).toBe('')
  })

  test('rejects bad name + empty spec', () => {
    expect(CreatePluginSchema.safeParse({ name: '-bad', spec: 'x' }).success).toBe(false)
    expect(CreatePluginSchema.safeParse({ name: 'p1', spec: '' }).success).toBe(false)
  })
})

describe('UpdatePluginSchema', () => {
  test('all fields optional', () => {
    expect(UpdatePluginSchema.parse({})).toEqual({})
    expect(UpdatePluginSchema.parse({ enabled: false })).toEqual({ enabled: false })
  })

  test('strict rejects unknown fields (no name in body — use /rename)', () => {
    const r = UpdatePluginSchema.safeParse({ name: 'p2' })
    expect(r.success).toBe(false)
  })
})

describe('RenamePluginSchema', () => {
  test('demands newName', () => {
    expect(RenamePluginSchema.safeParse({}).success).toBe(false)
    expect(RenamePluginSchema.safeParse({ newName: 'fresh' }).success).toBe(true)
  })
})

describe('PluginUpdateCheckSchema', () => {
  test('available + nullable current/latest', () => {
    expect(
      PluginUpdateCheckSchema.parse({ available: false, current: '1.0.0', latest: '1.0.0' }),
    ).toBeTruthy()
    expect(
      PluginUpdateCheckSchema.parse({ available: true, current: null, latest: null }),
    ).toBeTruthy()
  })
})

describe('AgentSchema.plugins', () => {
  test('CreateAgentSchema defaults plugins to []', () => {
    const r = CreateAgentSchema.parse({ name: 'a' })
    expect(r.plugins).toEqual([])
  })

  test('AgentSchema requires plugins array (no default on response)', () => {
    // Response shape: plugins must be present. The DB row builder is
    // responsible for materialising [] from the JSON column.
    const minimal = {
      id: 'a_01',
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      // intentionally NO plugins
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }
    expect(AgentSchema.safeParse(minimal).success).toBe(false)
    expect(AgentSchema.safeParse({ ...minimal, plugins: [] }).success).toBe(true)
  })

  test('rejects invalid plugin name in array', () => {
    const r = CreateAgentSchema.safeParse({ name: 'a', plugins: ['-bad'] })
    expect(r.success).toBe(false)
  })

  test('caps at 64 plugins per agent', () => {
    const many = Array.from({ length: 65 }, (_, i) => `p-${i}`)
    expect(CreateAgentSchema.safeParse({ name: 'a', plugins: many }).success).toBe(false)
  })
})
