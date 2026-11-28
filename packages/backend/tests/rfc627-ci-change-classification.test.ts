// RFC-627: fail-closed CI change classification, queue-coalescing range safety,
// strict Markdown docs-only allowlist, and full-trigger invariants.
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  classifyChangedPaths,
  DOCS_ONLY_DIR_PREFIXES,
  DOCS_ONLY_EXACT_PATHS,
  DOCS_ONLY_EXCLUDED_PATHS,
  FULL_TRIGGER_DIR_PREFIXES,
  FULL_TRIGGER_EXACT_PATHS,
  FULL_TRIGGER_FILE_PREFIXES,
  isDocsOnlyPath,
  isFullTriggerPath,
  MAX_ANCESTOR_DISTANCE,
  parseNullSeparatedPaths,
  resolveCiClassification,
  type CompletedWorkflowRun,
  type GitCommandResult,
} from '../../../scripts/ci/classify-ci-changes'
import {
  CORE_MIGRATION_SMOKE,
  discoverBackendTests,
  filterBackendTestsByTier,
} from '../../../scripts/ci/backend-shards'

const ROOT = resolve(import.meta.dir, '../../..')
const SHA_GREEN = '1'.repeat(40)
const SHA_OLDER_GREEN = '2'.repeat(40)
const SHA_HEAD = 'a'.repeat(40)
const SHA_PR_BASE = '3'.repeat(40)
const SHA_PR_HEAD = '4'.repeat(40)

const ok = (stdout = ''): GitCommandResult => ({ status: 0, stdout, stderr: '' })
const fail = (stderr = 'git error'): GitCommandResult => ({ status: 1, stdout: '', stderr })

describe('RFC-627 change classification rules', () => {
  test('strict Markdown allowlist admits root docs and design/docs/proposal Markdown while excluding contract docs and code', () => {
    for (const path of [
      'STATE.md',
      'CLAUDE.md',
      'AGENTS.md',
      'README.md',
      'README.zh-CN.md',
      'design/plan.md',
      'design/RFC-627-ci-throughput-tiered-verification/design.md',
      'docs/dev-gotchas.md',
      'proposal/init.md',
    ]) {
      expect(isDocsOnlyPath(path), path).toBe(true)
      expect(classifyChangedPaths([path]).mode, path).toBe('docs-only')
    }

    // Contract Markdown docs explicitly excluded from docs-only:
    expect(isDocsOnlyPath('design/RFC-395-database-target-schema-rebuild/table-mapping.md')).toBe(
      false,
    )
    expect(
      classifyChangedPaths(['design/RFC-395-database-target-schema-rebuild/table-mapping.md']).mode,
    ).toBe('full')
    expect(
      isDocsOnlyPath('design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md'),
    ).toBe(false)
    expect(
      classifyChangedPaths([
        'design/RFC-349-postgresql-provider-one-click-migration/schema-contract.md',
      ]).mode,
    ).toBe('full')
    expect(isDocsOnlyPath('docs/crewstation-automation.md')).toBe(false)
    expect(classifyChangedPaths(['docs/crewstation-automation.md']).mode).toBe('standard')

    // Non-Markdown under design/docs or Markdown outside allowed roots must never be docs-only:
    for (const [path, expectedMode] of [
      ['design/RFC-349-postgresql-provider-one-click-migration/schema-contract.json', 'full'],
      ['design/helper.ts', 'standard'],
      ['docs/diagram.svg', 'standard'],
      ['packages/backend/README.md', 'standard'],
      ['packages/backend/tests/helpers/rfc395Q1Parity/README.md', 'full'],
      ['e2e/README.md', 'standard'],
      ['.github/README.md', 'standard'],
      ['evidence/notes.md', 'standard'],
    ] as const) {
      expect(isDocsOnlyPath(path), path).toBe(false)
      expect(classifyChangedPaths([path]).mode, path).toBe(expectedMode)
    }
  })

  test('full-trigger rules cover persistence, migration, schemas, dual-engine helpers, CI, lockfiles, and fail-closed inputs', () => {
    for (const path of [
      'packages/backend/src/platform/persistence/sqliteRuntime.ts',
      'packages/backend/src/platform/content/migration/contentStore.ts',
      'packages/backend/src/platform/content/inventory/scanner.ts',
      'packages/backend/src/platform/contracts/historyRestriction.ts',
      'packages/backend/src/modules/system-operations/application/databaseMigrationRunner.ts',
      'packages/backend/src/modules/task-execution/composition/conversion.ts',
      'packages/backend/src/modules/task-execution/infrastructure/persistence/schema.ts',
      'packages/backend/src/modules/code-capability/infrastructure/persistence/historyQuerySchema.ts',
      'packages/backend/src/platform/audit/composition/schema.ts',
      'packages/backend/src/platform/audit/infrastructure/migration/v1.ts',
      'packages/backend/src/db/index.ts',
      'packages/backend/db/migrations/0001.sql',
      'packages/backend/src/bootstrap/epochMigrationBootstrap.ts',
      'packages/backend/src/bootstrap/autoUpgradeOrchestrator.ts',
      'packages/backend/src/bootstrap/conversionRules.ts',
      'packages/backend/src/bootstrap/migrate.ts',
      'packages/backend/src/bootstrap/persistenceSchema.ts',
      'packages/backend/src/bootstrap/targetSchemaRoster.json',
      'packages/backend/src/cli/epochMigration.ts',
      'packages/backend/src/cli/database.ts',
      'packages/backend/src/cli/backup.ts',
      'packages/backend/src/cli/restore.ts',
      'packages/backend/tests/fixtures/release-upgrade/releases.json',
      'packages/backend/tests/fixtures/shipped-migrations/sample.sql',
      'packages/backend/tests/helpers/eachProvider.ts',
      'packages/backend/tests/helpers/testDatabase.ts',
      'packages/backend/tests/helpers/releaseUpgrade/seed.ts',
      'packages/backend/tests/helpers/epoch1Protocol/fixture.ts',
      'packages/backend/tests/helpers/epoch2Snapshot.ts',
      'packages/backend/tests/rfc626-target-retire.test.ts',
      'packages/backend/tests/rfc370-m0-hosted-postgresql.integration.test.ts',
      'scripts/ci/classify-ci-changes.ts',
      'scripts/release-upgrade/registry.ts',
      'scripts/schema-history.ts',
      '.github/scripts/release-upgrade.ts',
      '.github/scripts/ci-postgresql-service.sh',
      '.github/workflows/ci.yml',
      '.github/workflows/ci-work.yml',
      '.github/workflows/backend-full-nightly.yml',
      '.github/workflows/ci-timings.yml',
      'package.json',
      'bun.lock',
      'bunfig.toml',
    ]) {
      expect(isFullTriggerPath(path), path).toBe(true)
      expect(classifyChangedPaths([path]).mode, path).toBe('full')
    }

    // Ordinary feature/UI/core test changes stay in standard mode.
    for (const path of [
      'packages/frontend/src/App.tsx',
      'packages/shared/src/types.ts',
      'packages/backend/src/modules/workflow-definition/application/workflows.ts',
      'packages/backend/tests/tasks.test.ts',
      'e2e/smoke.spec.ts',
    ]) {
      expect(isFullTriggerPath(path), path).toBe(false)
      expect(classifyChangedPaths([path]).mode, path).toBe('standard')
    }

    // Editing any CORE_MIGRATION_SMOKE test itself promotes to full because those files
    // belong to the release-upgrade / rfc395 / rfc398 migration test families.
    for (const path of CORE_MIGRATION_SMOKE) {
      expect(isFullTriggerPath(path), path).toBe(true)
      expect(classifyChangedPaths([path]).mode, path).toBe('full')
    }

    // Mixed sets upgrade to the strictest mode required.
    expect(classifyChangedPaths(['STATE.md', 'packages/frontend/src/App.tsx']).mode).toBe(
      'standard',
    )
    expect(
      classifyChangedPaths([
        'STATE.md',
        'packages/frontend/src/App.tsx',
        'packages/backend/src/db/schema.ts',
      ]).mode,
    ).toBe('full')

    // Empty or malformed diffs fail closed to full.
    expect(classifyChangedPaths([]).mode).toBe('full')
    for (const bad of [
      '',
      '/etc/passwd',
      'design/../STATE.md',
      'design\\a.md',
      'design/a\x01.md',
    ]) {
      expect(isDocsOnlyPath(bad), bad).toBe(false)
      expect(isFullTriggerPath(bad), bad).toBe(true)
      expect(classifyChangedPaths([bad]).mode, bad).toBe('full')
    }
  })

  test('every configured literal path and prefix is tracked in git (zero stale or untracked-only rules)', () => {
    const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((entry) => entry.length > 0)
    const trackedSet = new Set(trackedFiles)
    const trackedDirs = new Set<string>()
    for (const file of trackedFiles) {
      const parts = file.split('/')
      for (let depth = 1; depth < parts.length; depth++) {
        trackedDirs.add(`${parts.slice(0, depth).join('/')}/`)
      }
    }

    for (const path of [
      ...DOCS_ONLY_EXACT_PATHS,
      ...DOCS_ONLY_EXCLUDED_PATHS,
      ...FULL_TRIGGER_EXACT_PATHS,
    ]) {
      expect(trackedSet.has(path), `stale or untracked configured file: ${path}`).toBe(true)
    }

    for (const dir of [...DOCS_ONLY_DIR_PREFIXES, ...FULL_TRIGGER_DIR_PREFIXES]) {
      expect(trackedDirs.has(dir), `stale or untracked configured directory: ${dir}`).toBe(true)
    }

    for (const prefix of FULL_TRIGGER_FILE_PREFIXES) {
      const matches = trackedFiles.filter((file) => file.startsWith(prefix))
      expect(
        matches.length,
        `stale file prefix with zero tracked matches: ${prefix}`,
      ).toBeGreaterThan(0)
    }
  })

  test('structural invariant: every real migration-tier test file in the repo promotes CI to full', () => {
    const all = discoverBackendTests(ROOT)
    const migrationFiles = filterBackendTestsByTier(all, 'migration')
    expect(migrationFiles.length).toBeGreaterThanOrEqual(300)
    const unpromoted = migrationFiles.filter((file) => classifyChangedPaths([file]).mode !== 'full')
    expect(unpromoted).toEqual([])
  })

  test('structural invariant: every live schema contribution file and conversionRules import target promotes CI to full', () => {
    const schemaContributors: string[] = []
    const walkSrc = (dir: string, relPrefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${relPrefix}/${entry.name}`
        if (entry.isDirectory()) {
          walkSrc(join(dir, entry.name), rel)
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const text = readFileSync(join(dir, entry.name), 'utf8')
          if (/\bdefineContribution\(/.test(text)) schemaContributors.push(rel)
        }
      }
    }
    walkSrc(resolve(ROOT, 'packages/backend/src'), 'packages/backend/src')
    expect(schemaContributors.length).toBeGreaterThanOrEqual(15)
    expect(schemaContributors.filter((file) => !isFullTriggerPath(file))).toEqual([])

    const conversionRules = readFileSync(
      resolve(ROOT, 'packages/backend/src/bootstrap/conversionRules.ts'),
      'utf8',
    )
    const importedTargets = [...conversionRules.matchAll(/from\s+['"]@\/([^'"]+)['"]/g)].map(
      (match) => {
        const base = `packages/backend/src/${match[1]!}`
        return existsSync(resolve(ROOT, `${base}.ts`)) ? `${base}.ts` : `${base}/index.ts`
      },
    )
    expect(importedTargets.length).toBeGreaterThanOrEqual(10)
    expect(importedTargets.filter((file) => !isFullTriggerPath(file))).toEqual([])
  })

  test('parseNullSeparatedPaths deduplicates and sorts NUL-delimited git diff output', () => {
    expect(parseNullSeparatedPaths('b.ts\0a.ts\0b.ts\0\0c/d e.md\0')).toEqual([
      'a.ts',
      'b.ts',
      'c/d e.md',
    ])
  })
})

describe('RFC-627 range resolution, queue coalescing, and fail-closed fallbacks', () => {
  function makeGit(options: {
    ancestors?: ReadonlySet<string>
    distances?: Readonly<Record<string, number>>
    present?: ReadonlySet<string>
    fetchSucceeds?: boolean
    diffStdout?: string
    diffStatus?: number
  }) {
    const calls: string[][] = []
    const present = new Set(options.present ?? [SHA_GREEN, SHA_OLDER_GREEN, SHA_HEAD])
    const ancestors = options.ancestors ?? new Set([SHA_GREEN, SHA_OLDER_GREEN])
    const distances = options.distances ?? { [SHA_GREEN]: 2, [SHA_OLDER_GREEN]: 5 }

    const git = (args: readonly string[]): GitCommandResult => {
      calls.push([...args])
      if (args[0] === 'cat-file') {
        const sha = args[2]!.replace(/\^\{commit\}$/, '')
        return present.has(sha) ? ok() : fail('missing commit')
      }
      if (args[0] === 'fetch') {
        if (options.fetchSucceeds === false) return fail('fetch failed')
        present.add(args[args.length - 1]!)
        return ok()
      }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return ancestors.has(args[2]!) ? ok() : fail('not ancestor')
      }
      if (args[0] === 'rev-list' && args[1] === '--count') {
        const base = args[2]!.split('..')[0]!
        const distance = distances[base]
        return distance === undefined ? fail('unknown') : ok(`${distance}\n`)
      }
      if (args[0] === 'diff') {
        if ((options.diffStatus ?? 0) !== 0) return fail('diff failed')
        return ok(options.diffStdout ?? '')
      }
      throw new Error(`Unexpected git args: ${JSON.stringify(args)}`)
    }
    return { git, calls }
  }

  const greenRun = (overrides: Partial<CompletedWorkflowRun> = {}): CompletedWorkflowRun => ({
    id: 1001,
    conclusion: 'success',
    head_sha: SHA_GREEN,
    head_repository: { full_name: 'owner/repo' },
    ...overrides,
  })

  test('queue coalescing: superseded code push followed by docs-only push evaluates cumulative diff as standard', () => {
    const { git, calls } = makeGit({
      diffStdout: 'packages/frontend/src/App.tsx\0STATE.md\0',
    })
    const result = resolveCiClassification({
      eventName: 'push',
      payload: {},
      headSha: SHA_HEAD,
      repository: 'owner/repo',
      currentRunId: 2000,
      git,
      listCompletedMainPushRuns: () => [
        greenRun({ id: 1005, conclusion: 'cancelled', head_sha: '5'.repeat(40) }),
        greenRun({ id: 1004, conclusion: 'failure', head_sha: '6'.repeat(40) }),
        greenRun({ id: 1001, conclusion: 'success', head_sha: SHA_GREEN }),
      ],
    })
    expect(result).toMatchObject({
      mode: 'standard',
      baseSha: SHA_GREEN,
      linksBaseSha: SHA_GREEN,
      changedCount: 2,
    })
    expect(calls).toContainEqual(['diff', '--name-only', '-z', '--no-renames', SHA_GREEN, SHA_HEAD])
  })

  test('queue coalescing: superseded migration push followed by regular code push promotes to full', () => {
    const { git } = makeGit({
      diffStdout: 'packages/backend/src/db/schema.ts\0packages/frontend/src/App.tsx\0',
    })
    const result = resolveCiClassification({
      eventName: 'push',
      payload: {},
      headSha: SHA_HEAD,
      repository: 'owner/repo',
      currentRunId: 2000,
      git,
      listCompletedMainPushRuns: () => [greenRun()],
    })
    expect(result).toMatchObject({
      mode: 'full',
      baseSha: SHA_GREEN,
      linksBaseSha: SHA_GREEN,
      changedCount: 2,
    })
  })

  test('consecutive docs-only push stays docs-only and passes exact linksBaseSha', () => {
    const { git } = makeGit({ diffStdout: 'STATE.md\0design/plan.md\0' })
    const result = resolveCiClassification({
      eventName: 'push',
      payload: {},
      headSha: SHA_HEAD,
      repository: 'owner/repo',
      currentRunId: 2000,
      git,
      listCompletedMainPushRuns: () => [greenRun()],
    })
    expect(result).toMatchObject({
      mode: 'docs-only',
      baseSha: SHA_GREEN,
      linksBaseSha: SHA_GREEN,
      changedCount: 2,
    })
  })

  test('ignores foreign repo runs, current run ID, non-ancestors, and runs beyond MAX_ANCESTOR_DISTANCE', () => {
    const { git } = makeGit({
      present: new Set([SHA_GREEN, SHA_OLDER_GREEN, SHA_HEAD, '7'.repeat(40)]),
      ancestors: new Set([SHA_OLDER_GREEN, SHA_GREEN]),
      distances: { [SHA_GREEN]: MAX_ANCESTOR_DISTANCE + 1, [SHA_OLDER_GREEN]: 10 },
      diffStdout: 'STATE.md\0',
    })
    const result = resolveCiClassification({
      eventName: 'push',
      payload: {},
      headSha: SHA_HEAD,
      repository: 'owner/repo',
      currentRunId: 2000,
      git,
      listCompletedMainPushRuns: () => [
        greenRun({ id: 2000, head_sha: SHA_HEAD }),
        greenRun({ id: 1999, head_repository: { full_name: 'fork/repo' } }),
        greenRun({ id: 1998, head_sha: '7'.repeat(40) }), // not ancestor
        greenRun({ id: 1997, head_sha: SHA_GREEN }), // distance 201 > 200
        greenRun({ id: 1996, head_sha: SHA_OLDER_GREEN }), // valid
      ],
    })
    expect(result).toMatchObject({
      mode: 'docs-only',
      baseSha: SHA_OLDER_GREEN,
      linksBaseSha: SHA_OLDER_GREEN,
    })
  })

  test('workflow_dispatch defaults to fail-closed full and supports auto classification', () => {
    const { git } = makeGit({ diffStdout: 'STATE.md\0' })
    expect(
      resolveCiClassification({
        eventName: 'workflow_dispatch',
        payload: {},
        dispatchMode: 'full',
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    expect(
      resolveCiClassification({
        eventName: 'workflow_dispatch',
        payload: {},
        dispatchMode: undefined,
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    expect(
      resolveCiClassification({
        eventName: 'workflow_dispatch',
        payload: {},
        dispatchMode: 'auto',
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'docs-only', baseSha: SHA_GREEN, linksBaseSha: SHA_GREEN })
  })

  test('pull_request compares immutable base/head SHAs and fetches missing commits', () => {
    const { git, calls } = makeGit({
      present: new Set([SHA_PR_HEAD]),
      diffStdout: 'docs/dev-gotchas.md\0',
    })
    const result = resolveCiClassification({
      eventName: 'pull_request',
      payload: {
        pull_request: {
          base: { sha: SHA_PR_BASE },
          head: { sha: SHA_PR_HEAD },
        },
      },
      headSha: 'f'.repeat(40), // synthetic merge SHA must not be used
      repository: 'owner/repo',
      currentRunId: 2000,
      git,
      listCompletedMainPushRuns: () => null,
    })
    expect(result).toMatchObject({
      mode: 'docs-only',
      baseSha: SHA_PR_BASE,
      linksBaseSha: SHA_PR_BASE,
    })
    expect(calls).toContainEqual([
      'fetch',
      '--no-tags',
      '--filter=blob:none',
      '--depth=1',
      'origin',
      SHA_PR_BASE,
    ])
    expect(calls).toContainEqual([
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      SHA_PR_BASE,
      SHA_PR_HEAD,
    ])
  })

  test('every error or ambiguity fails closed to mode=full and linksBaseSha=ALL', () => {
    // API unavailable
    expect(
      resolveCiClassification({
        eventName: 'push',
        payload: {},
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({}).git,
        listCompletedMainPushRuns: () => null,
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    // No ancestor within distance
    expect(
      resolveCiClassification({
        eventName: 'push',
        payload: {},
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({ distances: { [SHA_GREEN]: MAX_ANCESTOR_DISTANCE + 5 } }).git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    // Empty diff (e.g. auto dispatch on an already-green HEAD)
    expect(
      resolveCiClassification({
        eventName: 'workflow_dispatch',
        payload: {},
        dispatchMode: 'auto',
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({ diffStdout: '' }).git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    // git diff failure
    expect(
      resolveCiClassification({
        eventName: 'push',
        payload: {},
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({ diffStatus: 128 }).git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    // Missing PR SHAs / failed PR fetch / unsupported event / invalid headSha
    expect(
      resolveCiClassification({
        eventName: 'pull_request',
        payload: {},
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({}).git,
        listCompletedMainPushRuns: () => null,
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    expect(
      resolveCiClassification({
        eventName: 'pull_request',
        payload: { pull_request: { base: { sha: SHA_PR_BASE }, head: { sha: SHA_PR_HEAD } } },
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({ present: new Set(), fetchSucceeds: false }).git,
        listCompletedMainPushRuns: () => null,
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    expect(
      resolveCiClassification({
        eventName: 'schedule',
        payload: {},
        headSha: SHA_HEAD,
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({}).git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })

    expect(
      resolveCiClassification({
        eventName: 'push',
        payload: {},
        headSha: 'not-a-sha',
        repository: 'owner/repo',
        currentRunId: 2000,
        git: makeGit({}).git,
        listCompletedMainPushRuns: () => [greenRun()],
      }),
    ).toMatchObject({ mode: 'full', baseSha: '', linksBaseSha: 'ALL' })
  })
})
