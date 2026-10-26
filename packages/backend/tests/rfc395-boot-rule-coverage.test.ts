// RFC-395 B handoff guards: final A/F/X assembly owns activation; tests execute together at T18.
import { expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { conversionContributions } from '@/bootstrap/conversionRules'
import { genericCopyTables } from '@/platform/persistence/migration/conversion/generic/tables'
import { conversion as alignment } from '@/platform/persistence/migration/conversion/alignment'
import { conversion as repository } from '@/modules/source-control/infrastructure/migration/repositoryUrlRule'
import { conversion as schedule } from '@/modules/integration/infrastructure/migration/scheduledPayloadRule'
import { conversion as runtime } from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
import { conversion as fusion } from '@/modules/knowledge-evolution/infrastructure/migration/fusionProvenanceRule'
import { conversion as memory } from '@/modules/memory/infrastructure/migration/legacyBootMemoryRule'
import { createSkillBootConversion } from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import {
  createBootUpgradeFacts,
  skillBootIdentityFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { resolveContributions } from '@/platform/persistence/migration/conversion/plan'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import { buildLookups } from '@/platform/persistence/migration/conversion/lookups'

import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'

import { tmpdir } from 'node:os'
import {
  createBootUpgradeEnvironment,
  type BootUpgradeCaptureInput,
} from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { makeSwitchFixture } from './rfc395-v3-switch-domain.test'
import { emptyV2Content } from './helpers/rfc395V2Harness'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'

const skills = createSkillBootConversion(async () => {
  throw new Error('coverage test never converts bytes')
})
const contributions = [repository, skills, fusion, memory, schedule, runtime]
const expected = {
  cached_repos: 'source-control/boot-repository-urls',
  skills: 'resource-catalog/boot-skills',
  skill_versions: 'resource-catalog/boot-skills',
  fusions: 'knowledge-evolution/boot-fusion-provenance',
  memories: 'memory/boot-fused-provenance',
  scheduled_tasks: 'integration/boot-scheduled-payload',
  runtimes: 'runtime-management/boot-runtime-config',
}
test('six owner rules have exactly one claim for each boot source table and no Task claims', () => {
  const rules = contributions.flatMap((entry) => entry.rules)
  expect(rules).toHaveLength(6)
  for (const [table, id] of Object.entries(expected))
    expect(rules.filter((rule) => rule.claims.includes(table)).map((rule) => rule.ref)).toEqual([
      { id, version: id === 'resource-catalog/boot-skills' ? 1 : 2 },
    ])
  expect(rules.flatMap((rule) => rule.claims)).not.toContain('tasks')
  expect(rules.flatMap((rule) => rule.claims)).not.toContain('task_repos')
  expect(genericCopyTables.filter((table) => Object.hasOwn(expected, table))).toEqual([])
  expect(alignment.rules.some((rule) => rule.claims.includes('memories'))).toBe(false)
  expect(skills.rules[0]!.produces.map((entry) => entry.table)).toEqual([
    'skills',
    'skill_versions',
    'content_objects',
    'content_bytes',
    'skill_content_entries',
  ])
})
test('final assembly replaces old content/alignment/generic claims and keeps existing seq/history rules', () => {
  const rules = conversionContributions.flatMap((entry) => entry.rules)
  for (const [table, id] of Object.entries(expected))
    expect(rules.filter((rule) => rule.claims.includes(table)).map((rule) => rule.ref)).toEqual([
      { id, version: id === 'resource-catalog/boot-skills' ? 1 : 2 },
    ])
  expect(
    rules.some((rule) => rule.ref.id === 'task-execution/run/epoch1' && rule.ref.version >= 2),
  ).toBe(true)
  expect(
    rules.some((rule) => rule.ref.id === 'history/writer-drain' && rule.ref.version >= 2),
  ).toBe(true)
  expect(
    rules.some((rule) => rule.ref.id === 'history/family-cutovers' && rule.ref.version >= 1),
  ).toBe(true)
})
test('empty skill tables produce an empty lookup and orphan version identities are still covered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boot-orphan-')),
    staged = createStagingStore(root)
  try {
    const empty = await buildLookups(skills.lookups, staged)
    expect([...empty(skillBootIdentityFacts).entries()]).toEqual([])
    const key = [canonicalValue('version')]
    staged.put({
      table: 'skill_versions',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('skill_versions', key),
      values: { id: 'version', skill_id: 'missing', version_index: 1 },
      canonical: {
        key,
        values: [canonicalValue('version'), canonicalValue('missing'), canonicalValue(1)],
      },
    })
    const populated = createStagingStore(root)
    try {
      for (const row of staged.rows('skill_versions')) populated.put(row)
      const orphan = await buildLookups(skills.lookups, populated)
      expect(orphan(skillBootIdentityFacts).require('missing')).toMatchObject({
        state: 'blocked',
        reason: 'v2-boot-skill-orphan-version',
      })
    } finally {
      populated.close()
    }
  } finally {
    staged.close()
    rmSync(root, { recursive: true, force: true })
  }
})
test('binding rejects altered environment digest before lookups or rules execute', () => {
  const facts = createBootUpgradeFacts([])
  expect(() =>
    resolveContributions({
      contributions,
      target: persistenceSchema,
      preflight: {} as Parameters<typeof resolveContributions>[0]['preflight'],
      bootUpgradeFacts: { ...facts, environmentDigest: 'changed' },
    }),
  ).toThrow('v2-boot-facts-digest')
})
test('ordinary conversion and old restore use the shared runner environment checks', () => {
  const root = join(import.meta.dir, '../src/modules/system-operations/application/epochSwitch')
  const runner = readFileSync(join(root, 'runner.ts'), 'utf8')
  expect(runner).toContain('captureBootUpgradeFacts')
  expect(runner).toContain('assertBootEnvironment')
  const frozenPlan = runner.indexOf('const frozenPlan = buildEpochPlan')
  const createTarget = runner.indexOf('await deps.target.create({')
  expect(frozenPlan).toBeGreaterThan(-1)
  expect(createTarget).toBeGreaterThan(-1)
  expect(frozenPlan).toBeLessThan(createTarget)
  const restore = readFileSync(join(root, 'restore.ts'), 'utf8')
  expect(restore).toContain('planEpochOperation(s,')
  const application = readFileSync(join(root, 'application.ts'), 'utf8')
  expect(application).toContain('runEpochSwitch(s, input)')
  expect(runner.match(/await assertBootEnvironment\(\)/g)).toHaveLength(1)
})

test('planner refuses an absent boot environment port for admitted boot tables', async () => {
  const f = makeSwitchFixture(),
    discover = f.deps.source.discover
  f.deps.source = {
    ...f.deps.source,
    async discover(input) {
      const source = await discover(input)
      return {
        ...source,
        preflight: {
          ...source.preflight,
          tables: [
            {
              table: 'runtimes',
              physicalTable: 'runtimes',
              rows: 1,
              disposition: 'converted',
              destination: { kind: 'business', tables: ['runtimes'] },
              reason: 'fixture',
            },
          ],
        },
      }
    },
  }
  try {
    await expect(f.app.plan({})).rejects.toThrow('v3-boot-environment-capability-required')
    expect(f.control.installed).toBe(false)
  } finally {
    f.close()
  }
})

test('environment rejects duplicate contributions/facts and brackets capture with unchanged-source checks', async () => {
  const f = makeSwitchFixture()
  const source = await f.deps.source.discover({
    location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
    operationRoot: f.root,
    emptyTables: [],
  })
  const input: BootUpgradeCaptureInput = {
    stage: 'freeze',
    source,
    root: f.deps.defaultContentRoot,
    content: emptyV2Content,
    manifest: {
      version: 1,
      roots: [],
      files: [],
      objects: [],
      databaseTrees: [],
      digest: valueDigest([]),
    },
    readArtifact: async () => null,
    writeArtifact: async () => {},
  }
  const fact = {
    id: 'fact',
    kind: 'local-git' as const,
    material: { path: '/repo' },
    evidence: null,
  }
  const contribution = { id: 'same', capture: async () => [fact] }
  try {
    expect(() => createBootUpgradeEnvironment([contribution, contribution])).toThrow(
      'duplicate-environment-contribution',
    )
    await expect(
      createBootUpgradeEnvironment([contribution, { ...contribution, id: 'other' }]).capture(input),
    ).rejects.toThrow('duplicate-fact')
    const events: string[] = []
    let changed = false
    const stableInput = {
      ...input,
      source: {
        ...source,
        reader: {
          ...source.reader,
          async assertUnchanged() {
            events.push('check')
            if (changed) throw new Error('source-changed')
          },
        },
      },
    }
    const environment = createBootUpgradeEnvironment([
      {
        id: 'one',
        async capture() {
          events.push('capture')
          return [fact]
        },
      },
    ])
    expect((await environment.capture(stableInput)).facts).toEqual([fact])
    expect(events).toEqual(['check', 'capture', 'check'])
    events.length = 0
    changed = true
    await expect(environment.capture(stableInput)).rejects.toThrow('source-changed')
    expect(events).toEqual(['check'])
    events.length = 0
    changed = false
    await expect(
      createBootUpgradeEnvironment([
        {
          id: 'one',
          async capture() {
            events.push('capture')
            changed = true
            return [fact]
          },
        },
      ]).capture(stableInput),
    ).rejects.toThrow('source-changed')
    expect(events).toEqual(['check', 'capture', 'check'])
  } finally {
    await source.close()
    f.close()
  }
})
