// Regression for the real GitLab Issue intake observed on 2026-08-25: a new
// Digital Employee Case must refresh its cached repository before freezing the
// Case baseline. Once frozen, later retries must keep that exact baseline.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { employeeCases, employeeCaseWorkspaces, employeeReactionRounds } from '@/db/schema'
import { composeSqliteDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import {
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  composeSqliteRepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import {
  assertDevelopmentWorkspaceRepositoryFreshness,
  buildDevelopmentWorkspaceRepositoryPreparation,
  createDevelopmentWorkspaceRepositoryPreparation,
} from '@/services/developmentDeliveryDeps'
import { resolveCachedRepo } from '@/services/gitRepoCache'
import { DomainError } from '@/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const root = mkdtempSync(join(tmpdir(), 'rfc310-workspace-freshness-'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

function commitAndPush(source: string, body: string, message: string): string {
  writeFileSync(join(source, 'version.txt'), body)
  git(source, 'add', 'version.txt')
  git(
    source,
    '-c',
    'user.name=workspace freshness test',
    '-c',
    'user.email=workspace-freshness@example.com',
    'commit',
    '-q',
    '-m',
    message,
  )
  git(source, 'push', '-q', 'origin', 'main')
  return git(source, 'rev-parse', 'HEAD')
}

describe('RFC-310 Digital Employee workspace repository freshness', () => {
  test('fails closed instead of falling back to a stale local default branch', () => {
    const inspect = (
      input: Parameters<typeof assertDevelopmentWorkspaceRepositoryFreshness>[0],
    ) => {
      try {
        return { branch: assertDevelopmentWorkspaceRepositoryFreshness(input), error: null }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        return { branch: null, error: error.code }
      }
    }
    expect(
      inspect({
        repositoryId: 'repo-missing-main',
        urlRedacted: 'https://git.example.test/team/repo.git',
        configuredDefaultBranch: 'main',
        preparedDefaultBranch: 'main',
        ffOutcomes: [{ branch: 'main', warning: 'origin-ref-missing' }],
      }),
    ).toEqual({ branch: null, error: 'repo-ref-not-found' })
    expect(
      inspect({
        repositoryId: 'repo-no-default',
        urlRedacted: 'https://git.example.test/team/repo.git',
        configuredDefaultBranch: null,
        preparedDefaultBranch: null,
        ffOutcomes: [],
      }),
    ).toEqual({ branch: null, error: 'cached-repo-default-branch-unavailable' })
    expect(
      inspect({
        repositoryId: 'repo-current',
        urlRedacted: 'https://git.example.test/team/repo.git',
        configuredDefaultBranch: 'main',
        preparedDefaultBranch: 'main',
        ffOutcomes: [{ branch: 'main', warning: null }],
      }),
    ).toEqual({ branch: 'main', error: null })
  })

  test('refreshes before the first baseline freeze and never refreshes an existing Case scene', async () => {
    const testRoot = join(root, 'fresh-before-freeze')
    const source = join(testRoot, 'source')
    const remote = join(testRoot, 'remote.git')
    const appHome = join(testRoot, 'home')
    mkdirSync(source, { recursive: true })
    mkdirSync(remote, { recursive: true })
    git(source, 'init', '-q', '-b', 'main')
    git(remote, 'init', '-q', '--bare', '--initial-branch=main')
    git(source, 'remote', 'add', 'origin', `file://${remote}`)
    const initialSha = commitAndPush(source, 'version 1\n', 'initial')

    const db = createInMemoryDb(MIGRATIONS)
    const repositoryStore = composeSqliteRepositoryWorkspaceStore(db)
    const remoteUrl = `file://${remote}`
    const cached = await resolveCachedRepo({ store: repositoryStore, appHome }, { url: remoteUrl })
    expect(git(cached.cached.localPath, 'rev-parse', 'HEAD')).toBe(initialSha)

    const freshSha = commitAndPush(source, 'version 2\n', 'advance before Case launch')
    expect(freshSha).not.toBe(initialSha)

    const issueContext = {
      id: 'issue-freshness',
      revision: 1,
      typeId: 'development.issue-handling',
      stateJson: JSON.stringify({
        status: 'active',
        subjectRef: 'ISSUE-FRESHNESS',
        repositoryRef: cached.cached.id,
        request: {
          kind: 'body-and-files',
          body: 'Use the current target branch',
          externalId: null,
          uploads: [],
        },
        materialArtifactRefs: [],
      }),
      artifactRefs: [],
    }
    const plan = {
      schemaVersion: 1,
      roundRef: 'round-freshness',
      executionNonce: 'a'.repeat(64),
      caseRef: { id: 'case-freshness', revision: 1 },
      employeeTypeRef: { typeId: 'development', revision: 10 },
      inputContextRefs: [],
      triggeringEventRef: 'event:issue-freshness',
      workItemRef: 'analyze-implement',
      toolSlotRef: 'default',
      workContractRef: { contractId: 'development.analyze-implement', version: 1 },
      toolRegistrationRef: null,
      connectionRef: null,
      implementationRef: null,
      implementationKind: 'agent',
      implementationJson: null,
      inputSchemaId: 'development.input.v1',
      outputSchemaId: 'development.output.v1',
      semanticValidatorId: 'development.validator',
      executionPolicyRevision: 1,
      roundBudgetMs: 60_000,
      externalWaitDeadlineMs: 86_400_000,
      allowedEffectKinds: [],
      workspacePolicy: {
        mode: 'write',
        businessChangeOnOk: 'required',
        writablePrefixes: [],
        platformWritePrefixes: [],
      },
      inputEnvelopeJson: JSON.stringify({ contextsJson: JSON.stringify([issueContext]) }),
    } as const
    db.insert(employeeCases)
      .values({
        id: 'case-freshness',
        employeeId: 'employee-freshness',
        employeeRevision: 1,
        typeId: 'development',
        typeRevision: 10,
        primaryContextId: 'issue-freshness',
        executionPolicyRevision: 1,
        state: 'active',
        terminalKind: null,
        blockReason: null,
        currentWorkItemRef: 'analyze-implement',
        activeRoundId: 'round-freshness',
        revision: 1,
        writerGeneration: 1,
        createdAt: 1,
        updatedAt: 1,
        terminalAt: null,
      })
      .run()
    db.insert(employeeReactionRounds)
      .values({
        id: 'round-freshness',
        caseId: 'case-freshness',
        caseRevision: 1,
        inboxId: null,
        employeeId: 'employee-freshness',
        employeeRevision: 1,
        ruleId: 'continue-freshness',
        workItemRef: 'analyze-implement',
        workContractId: 'development.analyze-implement',
        workContractVersion: 1,
        toolId: null,
        toolRevision: null,
        executionPolicyRevision: 1,
        inputContextRefsJson: '[]',
        planJson: JSON.stringify(plan),
        state: 'running',
        executionRef: 'task-freshness',
        outputJson: null,
        attemptOrdinal: 0,
        createdAt: 2,
        updatedAt: 2,
        settledAt: null,
      })
      .run()

    let preparationCalls = 0
    const productionPreparation = buildDevelopmentWorkspaceRepositoryPreparation(
      createDevelopmentWorkspaceRepositoryPreparation({
        store: repositoryStore,
        appHome,
      }),
    )
    const workspaceInput = {
      db,
      appHome,
      reactionRounds: createEmployeeReactionRoundQueries(db),
      inputArtifacts: {
        copyBlobTo() {
          throw new Error('the freshness fixture has no uploads')
        },
      },
      repositoryPreparation: {
        async prepare(request: { readonly repositoryId: string }) {
          preparationCalls += 1
          expect(request.repositoryId).toBe(cached.cached.id)
          return await productionPreparation.prepare(request)
        },
      },
      sourceControl: bindEmployeeCaseWorkspaceParticipant(),
      conflictMerge: bindConflictMergeParticipant(),
      now: () => 10,
    }
    const workspace = composeSqliteDevelopmentEmployeeWorkspace(workspaceInput)
    const first = await workspace.prepare({
      planJson: JSON.stringify(plan),
      attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial' }),
    })
    expect(first.kind).toBe('repository')
    if (first.kind !== 'repository') return
    expect(preparationCalls).toBe(1)
    expect(first.baselineSha).toBe(freshSha)
    expect(readFileSync(join(first.workspacePath, 'version.txt'), 'utf8')).toBe('version 2\n')
    expect(
      db
        .select({ baselineSha: employeeCaseWorkspaces.baselineSha })
        .from(employeeCaseWorkspaces)
        .where(eq(employeeCaseWorkspaces.caseId, 'case-freshness'))
        .get()?.baselineSha,
    ).toBe(freshSha)

    commitAndPush(source, 'version 3\n', 'advance after Case freeze')
    const retry = await workspace.prepare({
      planJson: JSON.stringify(plan),
      attemptJson: JSON.stringify({ ordinal: 1, mode: 'same-scene' }),
    })
    expect(retry.kind).toBe('repository')
    if (retry.kind !== 'repository') return
    expect(preparationCalls).toBe(1)
    expect(retry.baselineSha).toBe(freshSha)
    expect(readFileSync(join(retry.workspacePath, 'version.txt'), 'utf8')).toBe('version 2\n')
  })
})
