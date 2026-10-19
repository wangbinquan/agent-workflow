// RFC-370 §10 V18 (a)(b) — repository facts and upload seeds run where the
// development files live.
//
// Why these tests exist: RFC-370 hosted sweep (2026-10-19). The repository
// facts collector ran `git rev-parse` and a `readdirSync` walk in the service
// container (no git there; the baseline is a `cs-workspace:` volume
// reference), and upload placement ran `mkdir` / `chmod` / `rename` on that
// reference as if it were a local path: a development mission's facts never
// resolved and every upload placement failed `upload-placement-failed`.
// These tests lock:
// - facts come from HEAD's committed tree (a baseline's working tree is not
//   kept current), as one scan that a volume selection runs in the volume;
// - the collector projects its cells from the scan wherever it ran;
// - the seed-tree steps (publish with modes, digest, discard) run natively
//   inside the volume, confined to its evidence seeds;
// - placement over a volume selection publishes and digests through tree
//   operations and never touches the service filesystem.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '@/util/git'
import { scanRepositoryFacts } from '@/modules/development-automation/infrastructure/repositoryFactsScan'
import { createRepositoryFactsCollectorFromLocations } from '@/modules/development-automation/infrastructure/repositoryFactsCollector'
import {
  placeUploadSeed,
  seedTreeDigestOf,
} from '@/modules/development-automation/infrastructure/uploadPlacement'
import { executeTaskImageDevelopmentOperation } from '@/modules/development-automation/composition/taskImageWorkspace'
import type { AutomationWorkspaceEffectsFactory } from '@/modules/development-automation/application/ports/automationWorkspaceEffects'

async function git(cwd: string, ...args: string[]) {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout
}

async function repository(root: string): Promise<string> {
  mkdirSync(join(root, 'core', 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(
    join(root, 'pom.xml'),
    '<project><modules><module>core</module></modules></project>\n',
  )
  writeFileSync(join(root, 'core', 'pom.xml'), '<project/>\n')
  writeFileSync(join(root, 'core', 'src', 'App.java'), 'class App {}\n')
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, 'CLAUDE.md'), '# agents\n')
  await git(root, 'init', '-q')
  await git(root, 'add', '-A')
  await git(root, '-c', 'user.email=v18@test', '-c', 'user.name=v18', 'commit', '-q', '-m', 'base')
  // Not committed: invisible to the scan, like a stale baseline working tree.
  writeFileSync(join(root, 'stray.py'), 'print(1)\n')
  return (await git(root, 'rev-parse', 'HEAD')).trim()
}

describe('RFC-370 V18 development volume operations', () => {
  test('repository facts come from the HEAD tree, skipping vendored directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc370-facts-'))
    try {
      const headSha = await repository(root)
      expect(await scanRepositoryFacts(root)).toEqual({
        headSha,
        languages: ['java'],
        buildSystems: ['maven'],
        moduleBuildDirs: ['', 'core'],
        mavenModules: ['core'],
        contributorDocs: ['CLAUDE.md'],
        languageByModule: ['core=java'],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the collector projects its cells from the scan wherever it ran', async () => {
    const scans: string[] = []
    const collector = createRepositoryFactsCollectorFromLocations(
      { localPath: async () => 'cs-workspace:development%3Ashared/repos/acceptance' } as never,
      async (localPath) => {
        scans.push(localPath)
        return {
          headSha: 'b'.repeat(40),
          languages: ['typescript'],
          buildSystems: ['npm'],
          moduleBuildDirs: [''],
          mavenModules: [],
          contributorDocs: ['AGENTS.md'],
          languageByModule: ['root=typescript'],
        }
      },
    )
    const out = await collector.collect({ repositoryId: 'repo-1' } as never)
    expect(scans).toEqual(['cs-workspace:development%3Ashared/repos/acceptance'])
    expect(out.factsRef).toBe(`repo:${'b'.repeat(40)}`)
    expect(out.cells['repository.moduleIds']).toMatchObject({ state: 'known', value: ['root'] })
    expect(out.cells['repository.buildSystems']).toMatchObject({ value: ['npm'] })
    const failing = createRepositoryFactsCollectorFromLocations(
      { localPath: async () => 'cs-workspace:development%3Ashared/repos/acceptance' } as never,
      async () => {
        throw new Error('repository HEAD unresolvable')
      },
    )
    await expect(failing.collect({ repositoryId: 'repo-1' } as never)).rejects.toThrow(
      'repository HEAD unresolvable: repo-1',
    )
  })

  test('the task image scans, publishes, digests and discards inside the volume only', async () => {
    const volume = mkdtempSync(join(tmpdir(), 'aw-rfc370-development-volume-'))
    const tree = (operation: string, input: unknown) =>
      executeTaskImageDevelopmentOperation('development-tree', { operation, input }, volume)
    try {
      const repo = join(volume, 'repos', 'acceptance')
      mkdirSync(repo, { recursive: true })
      const headSha = await repository(repo)
      expect(await tree('repository-facts-scan', { root: repo })).toMatchObject({
        value: { headSha, mavenModules: ['core'] },
      })
      const seeds = join(volume, 'evidence', 'seeds')
      const staging = join(seeds, 'plan.tmp-1')
      mkdirSync(join(staging, 'bin'), { recursive: true })
      writeFileSync(join(staging, 'bin', 'run.sh'), 'echo seed\n')
      const root = join(seeds, 'plan')
      await tree('seed-tree-publish', {
        staging,
        root,
        modes: [{ path: 'bin/run.sh', mode: 0o755 }],
      })
      expect(existsSync(staging)).toBe(false)
      expect(statSync(join(root, 'bin', 'run.sh')).mode & 0o777).toBe(0o755)
      expect(await tree('seed-tree-digest', { root })).toEqual({ value: seedTreeDigestOf(root) })
      await tree('seed-tree-discard', { root })
      expect(existsSync(root)).toBe(false)
      await expect(tree('seed-tree-discard', { root: join(volume, 'repos') })).rejects.toThrow(
        'hosted-development-seed-path-invalid',
      )
    } finally {
      rmSync(volume, { recursive: true, force: true })
    }
  })

  test('placement over a volume selection publishes and digests through tree operations', async () => {
    const SEEDS = 'cs-workspace:development%3Ashared/evidence/seeds'
    const calls: [string, unknown][] = []
    const materialized: string[] = []
    const workspace: AutomationWorkspaceEffectsFactory = {
      resolve: (root, ...segments) => [root, ...segments].join('/'),
      parent: (reference) => reference,
      acquire: () =>
        ({
          exists: async () => false,
          createDirectory: async (reference: string) => {
            calls.push(['createDirectory', reference])
          },
          close: async () => {},
        }) as never,
      treeOperations: {
        run: async (operation, input) => {
          calls.push([operation, input])
          return operation === 'seed-tree-digest' ? 'd'.repeat(64) : null
        },
      },
    }
    const recorded: unknown[] = []
    const result = await placeUploadSeed(
      {
        persistence: {
          load: async () => ({
            planDigest: 'plan',
            baselineSnapshotRef: 'snap',
            baselineSha: 'c'.repeat(40),
            placementReceipt: null,
            entries: [
              {
                ordinal: 0,
                fileId: 'file-1',
                expectedTargetKind: 'absent',
                repositoryTargetPath: 'bin/run.sh',
                uploadBlobRef: 'blob-1',
                targetFileMode: 'executable',
              },
            ],
          }),
          record: async (row: unknown) => {
            recorded.push(row)
          },
        } as never,
        evidence: {
          materializeBlob: async (_ref: string, dest: string) => {
            materialized.push(dest)
            return true
          },
        } as never,
        seedsRoot: SEEDS,
        now: () => 1,
        workspace,
      },
      { planId: 'plan-1' },
    )
    expect(result).toMatchObject({ seedChangeRef: 'plan', seedTreeDigest: 'd'.repeat(64) })
    expect(materialized).toHaveLength(1)
    expect(materialized[0]).toStartWith(`${SEEDS}/plan.tmp-`)
    expect(materialized[0]).toEndWith('/bin/run.sh')
    const publish = calls.find(([operation]) => operation === 'seed-tree-publish')
    expect(publish?.[1]).toMatchObject({
      root: `${SEEDS}/plan`,
      modes: [{ path: 'bin/run.sh', mode: 0o755 }],
    })
    expect(calls.at(-1)).toEqual(['seed-tree-digest', { root: `${SEEDS}/plan` }])
    expect(recorded).toHaveLength(1)
  })
})
