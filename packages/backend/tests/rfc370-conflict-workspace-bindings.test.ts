// RFC-370: actual DE Case persistence/recomposition and complete bootstrap owner selection.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import {
  cachedRepos,
  employeeCases,
  employeeReactionRounds,
  employeeRoundWorkspaceStates,
} from '@/db/schema'
import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import {
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
} from '@/modules/source-control/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { staticCachedRepositoryPreparation } from './helpers/staticCachedRepositoryPreparation'
import {
  heldEffect,
  enteredBeforeOutcome,
  OpaqueActionEffects,
  OpaqueConflictEffects,
  OpaqueContentFactory,
  OpaqueEvidenceArtifacts,
  OpaqueEmployeeCaseFactory,
  WorkspaceReferenceCodec,
} from './helpers/rfc370ConflictWorkspaceEffects'

function calls(source: ts.SourceFile, expression: string) {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression)
      result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
function property(source: ts.SourceFile, call: ts.CallExpression, name: string) {
  const argument = call.arguments[0]!
  if (!ts.isObjectLiteralExpression(argument))
    throw new Error('complete binding argument is missing')
  const entries = argument.properties.filter(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && entry.name.getText(source) === name,
  )
  expect(entries).toHaveLength(1)
  return entries[0]!.initializer.getText(source)
}

test('all nine actual conflict bindings and the paired bootstrap selection retain the explicit receiver', () => {
  for (const [path, receiver] of [
    ['cli/start.ts', 'input'],
    ['cli/postgresqlDaemonApplication.ts', 'input'],
    ['server.ts', 'deps'],
  ] as const) {
    const source = ts.createSourceFile(
      path,
      readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const bindings = calls(source, 'bindConflictMergeParticipant')
    expect(bindings).toHaveLength(3)
    for (const binding of bindings)
      expect(property(source, binding, 'effects')).toBe(`${receiver}.conflictMergeWorkspaceEffects`)
    const selection = calls(source, 'selectDevelopmentWorkspaceEffectBinding')
    expect(selection).toHaveLength(1)
    expect(property(source, selection[0]!, 'actionWorkspaceEffects')).toBe(
      `${receiver}.actionWorkspaceEffects`,
    )
    expect(property(source, selection[0]!, 'automationWorkspaceEffects')).toBe(
      `${receiver}.automationWorkspaceEffects`,
    )
    expect(property(source, selection[0]!, 'conflictWorkspaceSelected')).toBe(
      `${receiver}.conflictMergeWorkspaceEffects !== undefined`,
    )
  }
  const start = readFileSync(new URL('../src/cli/start.ts', import.meta.url), 'utf8')
  for (const name of ['actionWorkspaceEffects', 'conflictMergeWorkspaceEffects']) {
    expect(start).toContain(`${name}: opts.${name},`)
    expect(start.split(`${name}: input.${name},`)).toHaveLength(3)
  }
})

describeEachProviderHttpApplication(
  'RFC-370 paired conflict owners at real HTTP/provider roots',
  {
    token: 'd'.repeat(64),
    dbVersion: 17,
    opencodeVersion: null,
    tempPrefix: 'aw-conflict-root-',
  },
  (scope) => {
    test('missing action owner fails before allocation, and a complete pair assembles without launching an effect', async () => {
      const codec = new WorkspaceReferenceCodec()
      const contents = new OpaqueContentFactory(codec)
      const conflict = new OpaqueConflictEffects(codec)
      const action = new OpaqueActionEffects(codec, contents)
      const error: unknown = await scope.open({ conflictMergeWorkspaceEffects: conflict }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('conflict-workspace-action-effects-required')
      expect(conflict.allocations).toEqual([])
      expect(action.allocations).toEqual([])
      const evidenceRoot = mkdtempSync(join(tmpdir(), 'aw-conflict-root-evidence-'))
      try {
        const evidence = new OpaqueEvidenceArtifacts(codec, evidenceRoot)
        const opened = await scope.open({
          conflictMergeWorkspaceEffects: conflict,
          actionWorkspaceEffects: action,
          evidenceArtifacts: evidence,
          evidenceDocumentCommands: evidence.documentCommands,
        })
        expect(opened.app).toBeDefined()
        expect(conflict.allocations).toEqual([])
        expect(action.allocations).toEqual([])
      } finally {
        rmSync(evidenceRoot, { recursive: true, force: true })
      }
    }, 120_000)

    test('selected conflict owners preserve independently selected native evidence storage', async () => {
      const codec = new WorkspaceReferenceCodec()
      const contents = new OpaqueContentFactory(codec)
      const conflict = new OpaqueConflictEffects(codec)
      const action = new OpaqueActionEffects(codec, contents)
      const opened = await scope.open({
        conflictMergeWorkspaceEffects: conflict,
        actionWorkspaceEffects: action,
      })
      expect(existsSync(join(opened.appHome, 'evidence', 'blobs'))).toBe(true)
      expect(existsSync(join(opened.appHome, 'evidence', 'bundles'))).toBe(true)
      expect(existsSync(join(opened.appHome, 'evidence', 'staging'))).toBe(true)
      expect(conflict.allocations).toEqual([])
      expect(action.allocations).toEqual([])
      expect(contents.calls).toEqual([])
    }, 120_000)
  },
)

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'rfc370',
      GIT_AUTHOR_EMAIL: 'rfc370@test',
      GIT_COMMITTER_NAME: 'rfc370',
      GIT_COMMITTER_EMAIL: 'rfc370@test',
    },
  })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return proc.stdout.toString().trim()
}

describeEachProvider(
  'RFC-370 selected DE conflict Case with actual Git and durable state',
  (harness) => {
    test('SC scene survives selected Case checkpoint and content ACK, then same-scene recompose/validate reuses it', async () => {
      const home = mkdtempSync(join(tmpdir(), 'aw-de-conflict-owner-'))
      const codec = new WorkspaceReferenceCodec()
      const contents = new OpaqueContentFactory(codec)
      const conflictHeld = heldEffect()
      let holdRead = false
      const conflict = new OpaqueConflictEffects(codec, async (effect) => {
        if (holdRead && effect === 'readConflictFile') await conflictHeld.wait()
      })
      const repo = join(home, 'repo')
      const remote = join(home, 'remote.git')
      try {
        mkdirSync(repo)
        git(repo, 'init', '-q', '-b', 'main')
        writeFileSync(join(repo, 'X.txt'), 'base\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'base')
        git(repo, 'checkout', '-q', '-b', 'feature/selected')
        writeFileSync(join(repo, 'X.txt'), 'source\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'source')
        const sourceSha = git(repo, 'rev-parse', 'HEAD')
        git(repo, 'checkout', '-q', 'main')
        writeFileSync(join(repo, 'X.txt'), 'target\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'target')
        const targetSha = git(repo, 'rev-parse', 'HEAD')
        mkdirSync(remote)
        git(remote, 'init', '-q', '--bare')
        git(repo, 'remote', 'add', 'origin', remote)
        git(repo, 'push', '-q', 'origin', 'main', 'feature/selected')
        git(repo, 'fetch', '-q', 'origin')
        const db = harness.db
        await db.insert(cachedRepos).values({
          id: 'selected-de-repo',
          urlHash: 'selected-de',
          urlEnc: null,
          urlRedacted: remote,
          localPath: codec.reference(repo),
          defaultBranch: 'main',
          lastFetchedAt: 1,
          createdAt: 1,
        })
        await db.insert(employeeCases).values({
          id: 'selected-de-case',
          employeeId: 'employee',
          employeeRevision: 1,
          typeId: 'development',
          typeRevision: 1,
          primaryContextId: 'issue',
          executionPolicyRevision: 1,
          state: 'active',
          terminalKind: null,
          blockReason: null,
          currentWorkItemRef: 'analyze-implement',
          activeRoundId: 'selected-de-initial',
          revision: 1,
          writerGeneration: 1,
          createdAt: 1,
          updatedAt: 1,
          terminalAt: null,
        })
        const issue = {
          typeId: 'development.issue-handling',
          stateJson: JSON.stringify({
            status: 'active',
            subjectRef: 'selected',
            repositoryRef: 'selected-de-repo',
            request: {
              kind: 'body-and-files',
              body: 'preserved selected requirement',
              externalId: null,
              workingBranch: 'feature/selected',
              uploads: [],
            },
            materialArtifactRefs: [],
          }),
        }
        const policy = {
          mode: 'write',
          businessChangeOnOk: 'required',
          writablePrefixes: [],
          platformWritePrefixes: [],
        }
        const makePlan = (roundRef: string, workItemRef: string, contexts: readonly object[]) => ({
          roundRef,
          caseRef: { id: 'selected-de-case', revision: 1 },
          workItemRef,
          workspacePolicy: policy,
          inputEnvelopeJson: JSON.stringify({ contextsJson: JSON.stringify(contexts) }),
        })
        const initialPlan = makePlan('selected-de-initial', 'analyze-implement', [issue])
        const repairPlan = makePlan('selected-de-conflict', 'repair-conflict', [
          issue,
          {
            typeId: 'development.merge-request',
            stateJson: JSON.stringify({
              status: 'active',
              headSha: sourceSha,
              targetSha,
              mergeableState: 'conflict',
            }),
          },
        ])
        const insertRound = async (plan: typeof initialPlan) => {
          await db.insert(employeeReactionRounds).values({
            id: plan.roundRef,
            caseId: 'selected-de-case',
            caseRevision: 1,
            inboxId: null,
            employeeId: 'employee',
            employeeRevision: 1,
            ruleId: 'selected-de',
            workItemRef: plan.workItemRef,
            workContractId: `development.${plan.workItemRef}`,
            workContractVersion: 1,
            toolId: null,
            toolRevision: null,
            executionPolicyRevision: 1,
            inputContextRefsJson: '[]',
            planJson: JSON.stringify(plan),
            state: 'running',
            executionRef: `execution-${plan.roundRef}`,
            outputJson: null,
            attemptOrdinal: 0,
            createdAt: 1,
            updatedAt: 1,
            settledAt: null,
          })
        }
        await insertRound(initialPlan)
        const caseEffects = new OpaqueEmployeeCaseFactory(codec)
        const compose = () =>
          composeDevelopmentEmployeeWorkspace({
            db,
            appHome: codec.reference(home),
            automationWorkspaceEffects: contents,
            reactionRounds: createEmployeeReactionRoundQueries(db),
            inputArtifacts: {
              async copyBlobTo() {
                throw new Error('no upload fixture')
              },
            },
            repositoryPreparation: staticCachedRepositoryPreparation(db),
            sourceControl: bindEmployeeCaseWorkspaceParticipant({ effects: caseEffects }),
            conflictMerge: bindConflictMergeParticipant({ effects: conflict }),
          })
        let workspace = compose()
        const initial = await workspace.prepare({
          planJson: JSON.stringify(initialPlan),
          attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial' }),
        })
        expect(initial.kind).toBe('repository')
        await db
          .update(employeeReactionRounds)
          .set({
            state: 'completed',
            updatedAt: 2,
            settledAt: 2,
          })
          .where(eq(employeeReactionRounds.id, initialPlan.roundRef))
        await db
          .update(employeeCases)
          .set({
            currentWorkItemRef: 'repair-conflict',
            activeRoundId: repairPlan.roundRef,
            updatedAt: 2,
          })
          .where(eq(employeeCases.id, 'selected-de-case'))
        await insertRound(repairPlan)
        const request = {
          planJson: JSON.stringify(repairPlan),
          attemptJson: JSON.stringify({ ordinal: 0, mode: 'initial' }),
        }
        const prepared = await workspace.prepare(request)
        expect(prepared.kind).toBe('repository')
        if (prepared.kind !== 'repository') throw new Error('actual conflict Case is missing')
        expect(prepared.workspacePath).toBe(conflict.allocations[0]!)
        const physical = codec.physical(prepared.workspacePath)
        expect(readFileSync(join(physical, 'X.txt'), 'utf8')).toContain('<<<<<<<')
        expect(
          readFileSync(
            join(physical, '.agent-workflow/inputs/requirements/selected-de-case/request.json'),
            'utf8',
          ),
        ).toContain('preserved selected requirement')
        const rows = await db.select().from(employeeRoundWorkspaceStates)
        const state = rows.find((row) => row.roundId === repairPlan.roundRef)!
        expect(JSON.parse(state.preStateJson)).toMatchObject({
          conflict: {
            workspacePath: prepared.workspacePath,
            sourceSha,
            targetSha,
            conflictPaths: ['X.txt'],
          },
        })
        expect(state.checkpointDigest).toMatch(/^[a-f0-9]{64}$/)
        workspace = compose()
        const replayed = await workspace.prepare({
          ...request,
          attemptJson: JSON.stringify({ ordinal: 1, mode: 'same-scene' }),
        })
        expect(replayed).toMatchObject({
          kind: 'repository',
          workspacePath: prepared.workspacePath,
        })
        expect(conflict.allocations).toHaveLength(1)
        writeFileSync(join(physical, 'X.txt'), 'resolved\n')
        holdRead = true
        let returned = false
        const validating = workspace
          .validate({
            roundRef: repairPlan.roundRef,
            taskStatus: 'done',
            outputJson: JSON.stringify({ status: 'ok' }),
          })
          .then((value) => {
            returned = true
            return value
          })
        await enteredBeforeOutcome(conflictHeld, validating)
        try {
          expect(returned).toBe(false)
        } finally {
          conflictHeld.release()
        }
        expect(await validating).toEqual({ ok: true })
        expect(conflict.calls).toContain('readConflictFile')
        expect(conflict.discards).toEqual([])
      } finally {
        conflictHeld.release()
        rmSync(home, { recursive: true, force: true })
      }
      expect(existsSync(home)).toBe(false)
    }, 120_000)
  },
)
