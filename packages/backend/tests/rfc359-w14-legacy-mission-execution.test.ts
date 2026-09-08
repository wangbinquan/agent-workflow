// RFC-359 P0-9: legacy mission -> action launcher -> real TaskEngine child ->
// persisted output -> original terminal observer -> attempt settlement.
// A no-change action settles here; this is not a completed mission delivery.
import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  requirementBundlePath,
} from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  cachedRepos,
  developmentActionRuns,
  developmentAgentAttempts,
  developmentWakeHints,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionIntents,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import {
  createActionTemplate,
  publishActionTemplate,
} from '@/modules/development-automation/application/commands/actionTemplateCommands'
import { launchMission } from '@/modules/development-automation/application/commands/launchMission'
import type { MissionDriveOutcome } from '@/modules/development-automation/application/missionDriver'
import {
  composeDevelopmentAdmissionLookup,
  composeDevelopmentAutomation,
  createDevelopmentMissionExecutionTerminalObserver,
} from '@/modules/development-automation/composition'
import { agentOutcomeEnvelopeSchema } from '@/modules/development-automation/domain/agentEnvelope'
import { defaultAutomationPolicyContent } from '@/modules/development-automation/domain/automationPolicy'
import { createActionTemplatePersistence } from '@/modules/development-automation/infrastructure/configResourceStore'
import { createMissionPersistence } from '@/modules/development-automation/infrastructure/missionStore'
import { createFactSnapshotReader } from '@/modules/development-automation/infrastructure/reconcilerReaders'
import { getAgentById } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { bindChangeCandidateParticipant } from '@/modules/source-control/composition'
import {
  DIGITAL_EMPLOYEE_AGENT_NODE_ID,
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_OUTPUT_NODE_ID,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  DIGITAL_EMPLOYEE_SCRIPT_NODE_ID,
} from '@/modules/task-execution/domain/digitalEmployeeHost'
import { runGit } from '@/util/git'
import { sha256Hex } from '@/util/hash'
import { legacyMissionScriptBody } from './fixtures/mock-opencode-legacy-mission'
import {
  createAutomationPolicy,
  createDigitalEmployee,
  publishAutomationPolicy,
  publishDigitalEmployee,
} from './helpers/digitalEmployeeStore'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const CHILD = resolve(import.meta.dir, 'fixtures', 'mock-opencode-legacy-mission.ts')

async function publishLegacyConfiguration(
  db: ProviderNeutralDatabase,
  userId: string,
  executor:
    | { kind: 'agent'; agentRef: string }
    | { kind: 'script'; language: 'node'; scriptRef: string },
): Promise<string> {
  const store = createActionTemplatePersistence(db)
  const template = await createActionTemplate(
    { store, now: Date.now },
    {
      actorUserId: userId,
      name: 'legacy-java-action',
      capabilityId: 'change.implement',
      draft: {
        schemaVersion: 1,
        capabilityId: 'change.implement',
        capabilityContractVersion: 1,
        labels: [],
        compatibility: [],
        executor,
        runtimeProfileRef: 'rt',
        promptSupplement: 'Return the actual legacy mission action result.',
        skillRefs: [],
        mcpRefs: [],
        readOnlyResourceRefs: [],
        contextProfileRef: null,
        writablePathPolicyRef: null,
        additionalProtectedPathClasses: [],
        verificationProfileRef: 'vp',
        retryDefaults: { sameSession: 0, freshSession: 0 },
      },
    },
  )
  await publishActionTemplate({ store, now: Date.now }, { id: template.id, actorUserId: userId })
  const policy = await createAutomationPolicy(db, {
    name: 'legacy-execution-policy',
    ownerUserId: userId,
    draft: {
      ...defaultAutomationPolicyContent(),
      actionPriority: {
        rules: [
          {
            ruleId: 'implement-ready-java',
            when: [
              { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true },
              { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
              // The legacy policy explicitly admits only its first action.
              { kind: 'enum-equals', fact: 'action.lastOutcome', value: 'none' },
            ],
            capabilityId: 'change.implement',
          },
        ],
      },
    },
  })
  await publishAutomationPolicy(db, { id: policy.id, publishedBy: userId })
  const employee = await createDigitalEmployee(db, {
    name: 'legacy-execution-employee',
    ownerUserId: userId,
    draft: {
      schemaVersion: 1,
      description: 'Real legacy action execution fixture',
      supportedRepositoryFacts: [],
      capabilityRoutes: [
        {
          capabilityId: 'change.implement',
          rules: [
            {
              ruleId: 'java-route',
              when: [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }],
              templateRef: { id: template.id, revision: 1 },
            },
          ],
          fallbackTemplateRef: null,
        },
      ],
      requirementSources: [],
      pipelineProviders: [],
      defaultPolicyRef: { id: policy.id, revision: 1 },
    },
  })
  await publishDigitalEmployee(db, { id: employee.id, publishedBy: userId })
  return employee.id
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 25_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntilReleased(
  execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>>,
  executionRef: string,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (
    execution.isActive(executionRef) ||
    (await execution.persistence.ownership.read(executionRef))?.state !== 'released'
  ) {
    if (Date.now() >= deadline) throw new Error(`task owner did not release ${executionRef}`)
    await delay(10)
  }
}

describeEachProvider('RFC-359 P0-9 legacy mission real execution', (harness) => {
  for (const kind of ['agent', 'script'] as const) {
    test(`${kind} action reaches done and its terminal observer settles the legacy attempt`, async () => {
      const { db } = harness
      const appHome = realpathSync(mkdtempSync(join(tmpdir(), 'aw-rfc359-legacy-mission-')))
      const repoPath = join(appHome, 'repo')
      const releasePath = join(appHome, 'release')
      const capturePath = join(appHome, 'child.json')
      const overrides = {
        AGENT_WORKFLOW_HOME: appHome,
        RFC359_MISSION_RELEASE: releasePath,
        RFC359_MISSION_CAPTURE: capturePath,
      }
      const previous = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]]),
      )
      Object.assign(process.env, overrides)
      let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
      let launchers:
        | ReturnType<
            Awaited<
              ReturnType<typeof createEachProviderTaskExecution>
            >['composeLegacyMissionLaunchers']
          >
        | undefined
      let terminalCallback: Promise<void> | undefined
      const terminalCompleted = Promise.withResolvers<void>()
      void terminalCompleted.promise.catch(() => {})
      try {
        mkdirSync(repoPath)
        await runGit(repoPath, ['init', '-q', '-b', 'main'])
        await runGit(repoPath, ['config', 'user.name', 'Legacy Mission Fixture'])
        await runGit(repoPath, ['config', 'user.email', 'legacy-mission@example.test'])
        writeFileSync(join(repoPath, 'pom.xml'), '<project/>\n')
        writeFileSync(join(repoPath, 'App.java'), 'class App {}\n')
        await runGit(repoPath, ['add', 'pom.xml', 'App.java'])
        await runGit(repoPath, ['commit', '-q', '-m', 'fixture'])
        const baselineSha = (await runGit(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()
        const userId = ulid()
        const agentId = ulid()
        const repositoryId = ulid()
        const scriptId = ulid()
        const now = Date.now()
        await db.insert(users).values({
          id: userId,
          username: `legacy-${userId}`,
          displayName: 'Legacy Mission Fixture',
          gitName: 'Legacy Mission Fixture',
          email: 'legacy-mission@example.test',
          role: 'admin',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        await db.insert(cachedRepos).values({
          id: repositoryId,
          urlHash: repositoryId,
          localPath: repoPath,
          defaultBranch: 'main',
          lastFetchedAt: now,
          createdAt: now,
        })
        await db.insert(agents).values({
          id: agentId,
          name: 'legacy-mission-agent',
          description: 'Real legacy child fixture',
          outputs: JSON.stringify([DIGITAL_EMPLOYEE_RESULT_PORT]),
          permission: '{}',
          skills: '[]',
          frontmatterExtra: '{}',
          bodyMd: 'Return the requested legacy action result.',
          createdAt: now,
          updatedAt: now,
        })
        const definition = JSON.stringify({
          $schema_version: WORKFLOW_SCHEMA_VERSION,
          inputs: [],
          nodes: [
            {
              id: 'legacy-script',
              kind: 'script',
              language: 'node',
              script: legacyMissionScriptBody(CHILD),
              dependencies: [],
              env: {
                RFC359_MISSION_RELEASE: releasePath,
                RFC359_MISSION_CAPTURE: capturePath,
              },
            },
          ],
          edges: [],
        })
        await db.insert(workflows).values({
          id: scriptId,
          name: 'legacy-mission-script',
          definition,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        const employeeId = await publishLegacyConfiguration(
          db,
          userId,
          kind === 'agent'
            ? { kind, agentRef: `${agentId}@1` }
            : { kind, language: 'node', scriptRef: `${scriptId}@${sha256Hex(definition)}` },
        )
        execution = await createEachProviderTaskExecution(
          harness,
          {
            appHome,
            binaryOverride: [process.execPath, 'run', CHILD],
            scriptInterpreters: { node: process.execPath },
            defaultNodeRetries: 0,
            defaultPerNodeTimeoutMs: 20_000,
          },
          userId,
          { completionMode: 'background' },
        )
        const observed = Promise.withResolvers<{
          missionId: string
          outcome: MissionDriveOutcome
        }>()
        // The launcher intentionally owns its watcher; retain errors for the
        // test even though the production observer catches drive failures.
        void observed.promise.catch(() => {})
        const terminalRefs: Array<{ kind: string; executionRef: string }> = []
        const observer = createDevelopmentMissionExecutionTerminalObserver({
          db,
          async drive(missionId) {
            try {
              const outcome = await automation.drive(missionId)
              observed.resolve({ missionId, outcome })
              return outcome
            } catch (error) {
              observed.reject(error)
              throw error
            }
          },
        })
        const notify = (executor: 'agent' | 'script', executionRef: string): Promise<void> => {
          terminalRefs.push({ kind: executor, executionRef })
          terminalCallback = observer[executor](executionRef).catch((error: unknown) => {
            observed.reject(error)
            throw error
          })
          void terminalCallback.then(terminalCompleted.resolve, terminalCompleted.reject)
          return terminalCallback
        }
        launchers = execution.composeLegacyMissionLaunchers({
          agents: { get: (id) => getAgentById(db, id) },
          onAgentTerminal: (ref) => notify('agent', ref),
          onScriptTerminal: (ref) => notify('script', ref),
          terminalPollMs: 10,
        })
        const lookup = composeDevelopmentAdmissionLookup(db)
        const automation = composeDevelopmentAutomation({
          db,
          appHome,
          admissionLookup: lookup,
          changeCandidate: bindChangeCandidateParticipant(),
          ...launchers,
        })
        const store = createMissionPersistence(db)
        const submission = {
          kind: 'direct',
          title: 'Add feature',
          body: 'do the thing',
          uploads: [],
        }
        const launched = await launchMission(
          { store, lookup, now: Date.now },
          {
            idempotencyKey: `legacy-mission-${kind}`,
            repositoryId,
            repositoryGroupId: null,
            submission,
            delivery: { kind: 'create-merge-request' },
            requestedEmployee: { id: employeeId, revision: 1 },
            requestedPolicy: null,
            actorUserId: userId,
          },
        )
        await automation.materializer.stashDirectSubmission({
          missionId: launched.missionId,
          submission: { title: submission.title, body: submission.body, uploads: [] },
        })
        // This is the only test-initiated drive. All subsequent business work
        // must enter through the original execution terminal observer above.
        expect(
          await automation.drive(launched.missionId),
          JSON.stringify({ blockCode: (await store.getMission(launched.missionId))?.blockCode }),
        ).toMatchObject({
          stop: 'async-boundary',
          last: { kind: 'decided', handled: 'action-launched' },
        })
        const initial = await store.getMission(launched.missionId)
        expect(initial?.currentActionRunId).toBeString()
        if (initial?.currentActionRunId == null) throw new Error('legacy action was not persisted')
        const actionRunId = initial.currentActionRunId
        const attempts = await store.listAttempts(actionRunId)
        expect(attempts).toHaveLength(1)
        const attempt = attempts[0]!
        expect(attempt.executionRef).toBeString()
        if (attempt.executionRef === null) throw new Error('legacy attempt executionRef missing')
        const executionRef = attempt.executionRef
        expect(terminalRefs).toEqual([])
        expect(
          (
            await db
              .select()
              .from(developmentAgentAttempts)
              .where(eq(developmentAgentAttempts.id, attempt.id))
          )[0]?.settledAt,
        ).toBeNull()
        expect(existsSync(capturePath)).toBe(false)
        expect((await launchers[`${kind}Launcher`].fetchOutcome(executionRef)).kind).toBe('pending')
        // Release only after the real reverse-join key has committed. The child
        // may already be waiting or may start later; both observe this same file.
        writeFileSync(releasePath, 'attempt.executionRef committed\n')
        // The actual launcher watcher has called the observer and that call
        // returned. A missing observer forwarding must fail on durable state,
        // before waiting for the drive signal it would never produce.
        await within(terminalCompleted.promise, 'legacy mission terminal callback')
        expect((await db.select().from(tasks).where(eq(tasks.id, executionRef)))[0]?.status).toBe(
          'done',
        )
        const settlement = {
          attemptStatus: (await store.listAttempts(actionRunId))[0]?.status,
          wakeDeliveryKeys: (
            await db
              .select({ deliveryKey: developmentWakeHints.deliveryKey })
              .from(developmentWakeHints)
              .where(eq(developmentWakeHints.missionId, launched.missionId))
          ).map((hint) => hint.deliveryKey),
        }
        expect(settlement).toEqual({
          attemptStatus: 'validated',
          wakeDeliveryKeys: [`${kind}-exec:${executionRef}`],
        })
        const terminal = await within(observed.promise, 'legacy mission terminal observer')
        await terminalCallback
        await waitUntilReleased(execution, executionRef)
        expect(terminal.missionId).toBe(launched.missionId)
        expect(terminal.outcome).toMatchObject({
          stop: 'failed-or-blocked',
          last: {
            kind: 'decided',
            handled: 'blocked',
            selected: { kind: 'block', reason: 'no-policy-match' },
          },
        })
        expect(terminalRefs).toEqual([{ kind, executionRef }])
        const [task] = await db.select().from(tasks).where(eq(tasks.id, executionRef))
        expect(task, task?.errorMessage ?? undefined).toMatchObject({
          status: 'done',
          errorSummary: null,
          errorMessage: null,
          catalogVisibility: 'internal',
          workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
          digitalEmployeeRoundId: actionRunId,
          baseCommit: baselineSha,
        })
        const sources = (await store.listMissionSources(launched.missionId)).filter(
          (source) => source.state === 'materialized' && source.bundleRef !== null,
        )
        expect(sources).toHaveLength(1)
        const source = sources[0]
        if (source?.bundleRef == null) throw new Error('materialized mission requirement missing')
        expect({
          spaceKind: task?.spaceKind,
          platformInputPathsJson: task?.platformInputPathsJson,
        }).toEqual({
          spaceKind: 'internal',
          platformInputPathsJson: JSON.stringify([requirementBundlePath(source.bundleRef)]),
        })
        expect(task?.finishedAt).toBeGreaterThanOrEqual(now)
        const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
        const envelope = agentOutcomeEnvelopeSchema.parse(capture.envelope)
        expect(capture.pid).toBeGreaterThan(0)
        expect(capture.pid).not.toBe(process.pid)
        expect(envelope).toMatchObject({
          actionRunRef: actionRunId,
          inputDigest: attempt.inputDigest,
          capabilityId: 'change.implement',
          outcome: 'no-change',
        })
        const snapshot = WorkflowDefinitionSchema.parse(JSON.parse(task!.workflowSnapshot))
        const executionNodeId =
          kind === 'agent' ? DIGITAL_EMPLOYEE_AGENT_NODE_ID : DIGITAL_EMPLOYEE_SCRIPT_NODE_ID
        expect(snapshot.nodes.map((node) => node.id)).toContain(executionNodeId)
        const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, executionRef))
        expect(runs).toHaveLength(3)
        expect(runs.every((run) => run.status === 'done')).toBe(true)
        const executedRun = runs.find((run) => run.nodeId === executionNodeId)!
        expect(executedRun.exitCode).toBe(0)
        expect(capture.cwd).toBe(executedRun.isoWorktreePath ?? task!.worktreePath)
        const outputRun = runs.find((run) => run.nodeId === DIGITAL_EMPLOYEE_OUTPUT_NODE_ID)!
        expect(
          await db
            .select({ port: nodeRunOutputs.portName, content: nodeRunOutputs.content })
            .from(nodeRunOutputs)
            .where(eq(nodeRunOutputs.nodeRunId, outputRun.id)),
        ).toEqual([{ port: DIGITAL_EMPLOYEE_RESULT_PORT, content: capture.frame }])
        expect(await launchers[`${kind}Launcher`].fetchOutcome(executionRef)).toEqual({
          kind: 'exited',
          executionRef,
          taskStatus: 'done',
          resultText: capture.frame,
          errorSummary: null,
          errorMessage: null,
        })
        expect(await store.listAttempts(actionRunId)).toMatchObject([
          {
            id: attempt.id,
            executionRef,
            status: 'validated',
            outcomeRef: null,
            rejectionJson: null,
          },
        ])
        expect(
          (
            await db
              .select()
              .from(developmentAgentAttempts)
              .where(eq(developmentAgentAttempts.id, attempt.id))
          )[0]?.settledAt,
        ).toBeGreaterThanOrEqual(now)
        expect(await store.getActionRun(actionRunId)).toMatchObject({ status: 'settled' })
        expect(await db.select({ id: tasks.id }).from(tasks)).toEqual([{ id: executionRef }])
        expect(
          await db
            .select({ id: developmentActionRuns.id })
            .from(developmentActionRuns)
            .where(eq(developmentActionRuns.missionId, launched.missionId)),
        ).toEqual([{ id: actionRunId }])
        const mission = await store.getMission(launched.missionId)
        expect(mission).toMatchObject({
          status: 'blocked',
          blockCode: 'action-stage-complete:no-change',
          currentActionRunId: null,
        })
        expect(mission?.requirementBundleRef).toBeString()
        if (mission?.requirementBundleRef == null) throw new Error('settled mission facts missing')
        expect(
          (await createFactSnapshotReader(db).getCells(mission.requirementBundleRef))?.[
            'action.lastOutcome'
          ],
        ).toMatchObject({ state: 'known', value: 'no-change' })
        const hints = await db
          .select()
          .from(developmentWakeHints)
          .where(eq(developmentWakeHints.missionId, launched.missionId))
        expect(hints).toHaveLength(1)
        expect(hints[0]).toMatchObject({
          missionId: launched.missionId,
          source: 'agent-execution',
          deliveryKey: `${kind}-exec:${executionRef}`,
        })
        expect(hints[0]?.consumedAt).toBeGreaterThanOrEqual(now)
        expect(await execution.persistence.ownership.read(executionRef)).toMatchObject({
          state: 'released',
        })
        expect(execution.isActive(executionRef)).toBe(false)
        expect(
          await db
            .select({ kind: taskExecutionIntents.kind, state: taskExecutionIntents.state })
            .from(taskExecutionIntents)
            .where(eq(taskExecutionIntents.taskId, executionRef)),
        ).toEqual([{ kind: 'launch', state: 'completed' }])
        expect(existsSync(join(task!.worktreePath!, 'App.java'))).toBe(true)
      } finally {
        writeFileSync(releasePath, 'teardown release\n')
        try {
          if (execution !== undefined && launchers !== undefined) {
            const launchedTasks = await db.select({ id: tasks.id }).from(tasks)
            for (const task of launchedTasks) {
              if (execution.isActive(task.id)) await launchers[`${kind}Launcher`].cancel(task.id)
              await waitUntilReleased(execution, task.id)
            }
            if (launchedTasks.length > 0) {
              await within(terminalCompleted.promise, 'terminal observer cleanup')
            }
          }
          if (terminalCallback !== undefined)
            await within(terminalCallback, 'terminal callback cleanup')
        } finally {
          execution?.shutdown()
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          rmSync(appHome, { recursive: true, force: true })
        }
      }
    }, 60_000)
  }
})
