// RFC-372: actual scheduler and native mock CLIs; no alternate Task host or continuation.
import { agentFixture, readTaskFixtures, taskFixture, workflowFixture } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createSqliteMemoryDistillEnqueuer } from './helpers/memoryDistill'
import {
  clarifyAnswerBasis,
  clarifyQuestionSetKey,
  type ClarifyQuestion,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { autoDispatchClarifyRound } from '@/modules/collaboration/infrastructure/clarify/autoDispatch'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { runGit } from '../src/util/git'
import { reenterScheduler } from './reenter-scheduler'
import ts from 'typescript'
import { inverseRfc372ClarifyRootBinding } from './helpers/rfc372ClarifyRootInverse'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_RUNTIME = resolve(import.meta.dir, 'fixtures', 'rfc372-native-runtime.ts')

// Each self/cross × runtime × session-mode case drives actual scheduler rounds
// and native mock processes. Allow process startup and continuation on busy CI
// hosts; assertions still require the original Task to reach its real terminal state.
setDefaultTimeout(60_000)

// A provider-neutral store alone is insufficient: both real HTTP bootstrap
// roots must supply the generator, or PostgreSQL responds "unavailable".
test('both daemon bootstraps bind follow-up generation into the original clarify routes', async () => {
  for (const path of ['../src/bootstrap/daemonHttpComposition.ts']) {
    const source = await Bun.file(new URL(path, import.meta.url)).text()
    expect(source).toMatch(
      /const collaborationRouteOperations = composeCollaborationRouteOperations\(\{\s*taskLock: composeHumanGateTaskLockPort,\s*followupGenerator: composeClarifyFollowupGenerator\(\{[\s\S]*?registry: (?:deps|core)\.runtimeRegistry,[\s\S]*?binding: narrativeSystemAgentBinding,/,
    )
    const fileName = fileURLToPath(new URL(path, import.meta.url))
    const parse = (text: string) =>
      ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    const restored = inverseRfc372ClarifyRootBinding(parse(source))
    expect(restored.text).not.toContain('composeClarifyFollowupGenerator')
    expect(inverseRfc372ClarifyRootBinding(parse(source + '\n// unknown root change\n')).text).toBe(
      restored.text + '\n// unknown root change\n',
    )
    expect(() =>
      inverseRfc372ClarifyRootBinding(
        parse(
          source.replace(
            'followupGenerator: composeClarifyFollowupGenerator({',
            'followupGenerator: unrelatedGenerator({',
          ),
        ),
      ),
    ).toThrow('clarify root inverse unreviewed')
  }
})

async function buildHarness() {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc026-parity-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  const argvPath = join(appHome, 'argv.jsonl')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    worktreePath,
    argvPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function setup(
  h: Awaited<ReturnType<typeof buildHarness>>,
  sessionMode: 'isolated' | 'inline',
  protocol: 'opencode' | 'claude-code',
  cross: boolean,
) {
  const agentId = ulid()
  await agentFixture(h.db, {
    id: agentId,
    name: 'designer',
    runtime: protocol,
    description: 't',
    outputs: JSON.stringify(['design']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const clarifyNode: Record<string, unknown> = {
    id: 'c',
    kind: cross ? 'clarify-cross-agent' : 'clarify',
    title: 'C',
    interactionMode: 'mindmap',
    mindmap: { categories: ['Scope'], instructions: '' },
  }
  if (cross) clarifyNode.sessionModeForQuestioner = sessionMode
  else clarifyNode.sessionMode = sessionMode
  const def: WorkflowDefinition = {
    $schema_version: 7,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'd', kind: 'agent-single', agentId, agentName: 'designer' } as WorkflowNode,
      clarifyNode as WorkflowNode,
      ...(cross
        ? [{ id: 'consumer', kind: 'agent-single', agentId, agentName: 'designer' } as WorkflowNode]
        : []),
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in', portName: 'req' },
        target: { nodeId: 'd', portName: 'req' },
      },
      {
        id: 'e2',
        source: { nodeId: 'd', portName: '__clarify__' },
        target: { nodeId: 'c', portName: 'questions' },
      },
      {
        id: 'e3',
        source: { nodeId: 'c', portName: cross ? 'to_questioner' : 'answers' },
        target: { nodeId: 'd', portName: '__clarify_response__' },
      },
      ...(cross
        ? [
            {
              id: 'to_consumer',
              source: { nodeId: 'c', portName: 'to_designer' },
              target: { nodeId: 'consumer', portName: '__external_feedback__' },
            },
          ]
        : []),
    ],
  }
  const taskId = ulid()
  const workflowId = ulid()
  await workflowFixture(h.db, { id: workflowId, name: 'wf', definition: JSON.stringify(def) })
  await taskFixture(h.db, {
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'go' }),
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

const CLARIFY_BODY = JSON.stringify({
  questions: [
    {
      id: 'q1',
      title: 'Choose scope',
      kind: 'single',
      options: ['A', 'B'],
      mindmap: { categoryPath: ['Scope'] },
    },
  ],
})

describe('RFC-372 mindmap uses the original TaskEngine continuation', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())
  for (const protocol of ['opencode', 'claude-code'] as const)
    for (const sessionMode of ['isolated', 'inline'] as const)
      for (const cross of [false, true]) {
        test(`${protocol}/${sessionMode}/${cross ? 'cross' : 'self'}: classified round -> confirmed stop -> normal output`, async () => {
          const taskId = await setup(h, sessionMode, protocol, cross)
          const prefix = protocol === 'opencode' ? 'MOCK_OPENCODE' : 'MOCK_CLAUDE'
          const cmd = ['bun', 'run', MOCK_RUNTIME, protocol]
          const common = {
            taskId,
            db: h.db,
            appHome: h.appHome,
            binaryOverride: cmd,
            sessionRestartBudget: 0,
          }
          const capture = { [`${prefix}_CAPTURE_ARGV_TO`]: h.argvPath }
          await withEnv({ ...capture, [`${prefix}_CLARIFY_BODY`]: CLARIFY_BODY }, () =>
            runTask(common),
          )
          const { clarifyRounds } = tablesOf(h.db)
          const round = (
            await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
          )[0]!
          expect(round).toBeDefined()
          expect(round.kind).toBe(cross ? 'cross' : 'self')
          const qs = JSON.parse(round.questionsJson) as ClarifyQuestion[]
          expect(qs[0]?.mindmap?.categoryPath).toEqual(['Scope'])
          const answers = qs.map((question) => {
            const value = {
              questionId: question.id,
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            }
            return { ...value, confirmedBasis: clarifyAnswerBasis(question, value) }
          })
          await autoDispatchClarifyRound({
            db: h.db,
            memoryDistillEnqueuer: createSqliteMemoryDistillEnqueuer(h.db),
            originNodeRunId: round.intermediaryNodeRunId,
            directive: 'stop',
            questionSetKey: clarifyQuestionSetKey(qs),
            answers,
            actor: { userId: 'u1', role: 'owner' },
          })
          await reenterScheduler(h.db, taskId)
          await withEnv(
            { ...capture, [`${prefix}_OUTPUTS`]: JSON.stringify({ design: 'ok' }) },
            () => runTask(common),
          )
          expect((await readTaskFixtures(h.db, { id: taskId }))[0]?.status).toBe('done')
          expect(
            (await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, round.id)))[0]
              ?.status,
          ).toBe('answered')
          const calls = readFileSync(h.argvPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const record = JSON.parse(line) as string[] | { argv: string[] }
              return Array.isArray(record) ? record : record.argv
            })
          expect(calls.length).toBeGreaterThanOrEqual(2)
          if (sessionMode === 'isolated')
            for (const argv of calls) {
              expect(argv).not.toContain('--session')
              expect(argv).not.toContain('--resume')
            }
        })
      }
})

test('the common daemon graph routes the selected observation and task bundle through the neutral follow-up owner', async () => {
  for (const path of ['../src/bootstrap/daemonApplication.ts']) {
    const source = await Bun.file(new URL(path, import.meta.url)).text()
    expect(source).toContain('composeProviderAppComposition({')
    expect(source).toContain('observation: observationModules')
    expect(source).toContain('taskExecution: taskExecutionModules')
  }
})
