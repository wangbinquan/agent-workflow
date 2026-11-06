// RFC-083 PR-B — dependency manifest parsing + set-diff. Locks the "new external
// package" signal across ecosystems. Parsers are best-effort and must never
// throw on half-edited manifests (an agent mid-change leaves these broken).

import { describe, expect, test } from 'bun:test'
import {
  parseManifest,
  ecosystemForManifest,
} from '../src/modules/workspace-insight/domain/structuralDiff/deps/manifests'
import {
  dependencyChangesForManifest,
  aggregateDependencyChanges,
} from '../src/modules/workspace-insight/domain/structuralDiff/deps/diff'
import type { DependencyChange } from '@agent-workflow/shared'

function byName(changes: DependencyChange[]): Map<string, DependencyChange> {
  return new Map(changes.map((c) => [c.packageName, c]))
}

describe('ecosystemForManifest', () => {
  test('maps known manifests', () => {
    expect(ecosystemForManifest('a/package.json')).toBe('npm')
    expect(ecosystemForManifest('Cargo.toml')).toBe('cargo')
    expect(ecosystemForManifest('go.mod')).toBe('go')
    expect(ecosystemForManifest('requirements.txt')).toBe('pip')
    expect(ecosystemForManifest('pyproject.toml')).toBe('pip')
    expect(ecosystemForManifest('pom.xml')).toBe('maven')
    expect(ecosystemForManifest('build.gradle.kts')).toBe('gradle')
    expect(ecosystemForManifest('build.sbt')).toBe('sbt')
    expect(ecosystemForManifest('vcpkg.json')).toBe('vcpkg')
    expect(ecosystemForManifest('src/main.rs')).toBeNull()
  })
})

describe('parseManifest — per ecosystem', () => {
  test('npm', () => {
    const m = parseManifest(
      'npm',
      '{"dependencies":{"react":"^18.0.0"},"devDependencies":{"vite":"5"}}',
    )
    expect(m.get('react')).toBe('^18.0.0')
    expect(m.get('vite')).toBe('5')
  })
  test('cargo — inline + table forms', () => {
    const m = parseManifest(
      'cargo',
      '[dependencies]\ntokio = "1.0"\nserde = { version = "1", features=["derive"] }\n[dev-dependencies]\nmockall = "0.11"\n',
    )
    expect(m.get('tokio')).toBe('1.0')
    expect(m.get('serde')).toBe('1')
    expect(m.get('mockall')).toBe('0.11')
  })
  test('go.mod — require block', () => {
    const m = parseManifest(
      'go',
      'module x\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/sync v0.1.0 // indirect\n)\n',
    )
    expect(m.get('github.com/a/b')).toBe('v1.2.3')
    expect(m.get('golang.org/x/sync')).toBe('v0.1.0')
  })
  test('pip requirements', () => {
    const m = parseManifest('pip', 'flask==2.0\nrequests>=2.28\n# comment\nnumpy\n')
    expect(m.get('flask')).toBe('2.0')
    expect(m.has('requests')).toBe(true)
    expect(m.has('numpy')).toBe(true)
  })
  test('maven', () => {
    const m = parseManifest(
      'maven',
      '<dependencies><dependency><groupId>org.x</groupId><artifactId>y</artifactId><version>1.0</version></dependency></dependencies>',
    )
    expect(m.get('org.x:y')).toBe('1.0')
  })
  test('gradle', () => {
    const m = parseManifest(
      'gradle',
      'implementation \'com.google.guava:guava:31.0\'\napi("org.x:y:2.0")\n',
    )
    expect(m.get('com.google.guava:guava')).toBe('31.0')
    expect(m.get('org.x:y')).toBe('2.0')
  })
  test('sbt', () => {
    const m = parseManifest(
      'sbt',
      'libraryDependencies += "org.typelevel" %% "cats-core" % "2.9.0"\n',
    )
    expect(m.get('org.typelevel:cats-core')).toBe('2.9.0')
  })
  test('vcpkg', () => {
    const m = parseManifest('vcpkg', '{"dependencies":["fmt",{"name":"boost","version>=":"1.80"}]}')
    expect(m.has('fmt')).toBe(true)
    expect(m.has('boost')).toBe(true)
  })
  test('malformed manifest never throws', () => {
    expect(parseManifest('npm', '{not json').size).toBe(0)
    expect(parseManifest('vcpkg', 'garbage').size).toBe(0)
  })
})

// Regression guards for parser bugs found by the RFC-083 completeness audit:
// phantom deps from cargo sub-tables / pyproject metadata, dropped poetry caret
// versions, and garbage from requirements options / VCS installs.
describe('parseManifest — audit regressions', () => {
  test('cargo [dependencies.foo] sub-table: only `foo`, no phantom version/features', () => {
    const m = parseManifest(
      'cargo',
      '[dependencies.serde]\nversion = "1.0"\nfeatures = ["derive"]\n\n[dependencies]\ntokio = "1"\n',
    )
    expect(m.has('serde')).toBe(true)
    expect(m.has('tokio')).toBe(true)
    expect(m.has('version')).toBe(false)
    expect(m.has('features')).toBe(false)
  })

  test('pyproject PEP 621: array deps only, not [project] metadata keys', () => {
    const m = parseManifest(
      'pip',
      '[project]\nname = "mypkg"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = ["requests>=2.28", "flask"]\n',
    )
    expect(m.get('requests')).toBe('2.28')
    expect(m.has('flask')).toBe(true)
    expect(m.has('name')).toBe(false)
    expect(m.has('version')).toBe(false)
    expect(m.has('requires-python')).toBe(false)
  })

  test('poetry table: caret/tilde versions kept, python excluded', () => {
    const m = parseManifest(
      'pip',
      '[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "^2.28"\nserde = { version = "~1.2", optional = true }\n',
    )
    expect(m.get('requests')).toBe('2.28')
    expect(m.get('serde')).toBe('1.2')
    expect(m.has('python')).toBe(false)
  })

  test('requirements.txt: skip -e / VCS / option lines', () => {
    const m = parseManifest(
      'pip',
      '-e .\n-r base.txt\ngit+https://github.com/x/y.git#egg=z\nflask==2.0\nnumpy\n',
    )
    expect(m.get('flask')).toBe('2.0')
    expect(m.has('numpy')).toBe(true)
    expect(m.has('-e')).toBe(false)
    expect(m.has('z')).toBe(false)
    expect(m.has('git')).toBe(false)
    expect(m.size).toBe(2)
  })
})

describe('dependencyChangesForManifest — set-diff', () => {
  test('added / removed / updated', () => {
    const changes = dependencyChangesForManifest({
      filePath: 'Cargo.toml',
      oldContent: '[dependencies]\ntokio = "1.0"\nold_dep = "0.1"\n',
      newContent: '[dependencies]\ntokio = "1.5"\nserde_json = "1"\n',
    })
    const m = byName(changes)
    expect(m.get('serde_json')?.changeType).toBe('added')
    expect(m.get('serde_json')?.versionAfter).toBe('1')
    expect(m.get('old_dep')?.changeType).toBe('removed')
    expect(m.get('tokio')?.changeType).toBe('updated')
    expect(m.get('tokio')?.versionBefore).toBe('1.0')
    expect(m.get('tokio')?.versionAfter).toBe('1.5')
    expect(m.get('tokio')?.viaManifest).toBe(true)
  })

  test('added manifest file (oldContent null) → all added', () => {
    const changes = dependencyChangesForManifest({
      filePath: 'go.mod',
      oldContent: null,
      newContent: 'module x\nrequire github.com/a/b v1.0.0\n',
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.changeType).toBe('added')
    expect(changes[0]?.ecosystem).toBe('go')
  })

  test('non-manifest path → no changes', () => {
    expect(
      dependencyChangesForManifest({ filePath: 'src/main.ts', oldContent: 'a', newContent: 'b' }),
    ).toEqual([])
  })

  test('aggregate sorts by ecosystem then package', () => {
    const out = aggregateDependencyChanges([
      { filePath: 'package.json', oldContent: '{}', newContent: '{"dependencies":{"zod":"3"}}' },
      { filePath: 'Cargo.toml', oldContent: '', newContent: '[dependencies]\naxum = "0.7"\n' },
    ])
    expect(out.map((c) => `${c.ecosystem}:${c.packageName}`)).toEqual(['cargo:axum', 'npm:zod'])
  })
})
