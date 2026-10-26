import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { composeHumanGateTaskLockPort } from '@/modules/task-execution/composition'
// RFC-395 II-a A4: persisted prompts, copied port archives and gate bodies retain the original read/fallback behavior on both providers.
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  storeNodeRunPromptContent,
  readNodeRunPromptContent,
} from '@/modules/task-execution/application/nodeRunPrompt'
import { createFileNodeRunPromptContent } from '@/modules/task-execution/infrastructure/local/fileNodeRunPromptContent'
import { createFilePortArtifactContent } from '@/modules/task-execution/infrastructure/local/filePortArtifactContent'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { copyPortArchive } from '@/platform/content/locations/portArchive'
import { legacyReviewArtifacts } from './helpers/legacyReviewArtifacts'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
import {
  taskFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunFixtures,
  readNodeRunOutputFixtures,
} from './helpers/model'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('A4 content persistence', (harness) => {
  const seedTask = async (id: string, home: string) =>
    taskFixture(harness.db, {
      id,
      workflowId: 'a4-workflow',
      workflowSnapshot: { $schema_version: 2, inputs: [], nodes: [], edges: [] },
      repoPath: home,
      worktreePath: home,
      baseBranch: 'main',
      branch: 'main',
      status: 'running',
      inputs: {},
      startedAt: 1000,
    })

  test('prompt threshold, file bytes, inline precedence, missing and write-failure fallback survive persistence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc395-a4-prompt-'))
    try {
      const taskId = ulid()
      await seedTask(taskId, home)
      const content = createFileNodeRunPromptContent(join(home, 'runs'))
      for (const prompt of ['中'.repeat(1365), '中'.repeat(1365) + 'x']) {
        const id = ulid()
        const stored = storeNodeRunPromptContent(content, taskId, id, prompt)
        await nodeRunFixture(harness.db, { id, taskId, nodeId: 'agent', status: 'done', ...stored })
        const row = (await readNodeRunFixtures(harness.db, { id }))[0]!
        expect(readNodeRunPromptContent(content, row)).toBe(prompt)
        if (Buffer.byteLength(prompt) < 4096)
          expect(stored).toEqual({ promptText: prompt, promptPath: null })
        else {
          expect(stored).toEqual({
            promptText: null,
            promptPath: join(taskId, 'prompts', `${id}.md`),
          })
          expect(readFileSync(join(home, 'runs', stored.promptPath!))).toEqual(Buffer.from(prompt))
        }
      }
      expect(readNodeRunPromptContent(content, { promptText: '', promptPath: 'missing' })).toBe('')
      expect(
        readNodeRunPromptContent(content, { promptText: null, promptPath: 'missing' }),
      ).toBeNull()
      expect(
        storeNodeRunPromptContent(
          {
            ...content,
            write() {
              throw new Error('disk failure')
            },
          },
          taskId,
          ulid(),
          'x'.repeat(4096),
        ),
      ).toEqual({ promptText: 'x'.repeat(4096), promptPath: null })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a parent call row retaining a child archive still falls back in the parent namespace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc395-a4-ports-'))
    try {
      const parent = ulid(),
        child = ulid(),
        run = ulid(),
        call = ulid()
      const workspace = join(home, 'workspace')
      mkdirSync(workspace)
      writeFileSync(join(workspace, 'doc.md'), 'child bytes')
      await seedTask(parent, workspace)
      await seedTask(child, workspace)
      await nodeRunFixture(harness.db, {
        id: run,
        taskId: child,
        nodeId: 'child-agent',
        status: 'done',
      })
      await nodeRunFixture(harness.db, { id: call, taskId: parent, nodeId: 'call', status: 'done' })
      const ports = composePortArtifactOperations(createFilePortArtifactContent(home))
      const archived = await ports.archive({
        taskId: child,
        nodeRunId: run,
        portName: 'doc',
        mountPath: '',
        items: [
          { sourcePath: 'doc.md', source: { workspaceRef: workspace, relativePath: 'doc.md' } },
        ],
      })
      await nodeRunOutputFixture(harness.db, {
        nodeRunId: run,
        portName: 'doc',
        content: 'doc.md',
        kind: 'path<md>',
        archiveJson: archived.archiveJson,
      })
      await nodeRunOutputFixture(harness.db, {
        nodeRunId: call,
        portName: 'doc',
        content: 'doc.md',
        kind: 'path<md>',
        archiveJson: copyPortArchive(archived.archiveJson),
      })
      const output = (await readNodeRunOutputFixtures(harness.db, { nodeRunId: call }))[0]!
      expect(output.archiveJson).toBe(archived.archiveJson)
      writeFileSync(join(workspace, 'doc.md'), 'parent fallback')
      const request = {
        archiveJson: output.archiveJson,
        content: output.content,
        kind: output.kind,
        fallbackWorkspaceRef: workspace,
      }
      expect((await ports.read({ ...request, taskId: child })).items[0]).toMatchObject({
        source: 'archive',
        body: 'child bytes',
      })
      expect((await ports.read({ ...request, taskId: parent })).items[0]).toMatchObject({
        source: 'worktree',
        body: 'parent fallback',
      })
      expect(
        (await ports.read({ ...request, taskId: parent, fallbackWorkspaceRef: null })).items[0],
      ).toMatchObject({ source: 'missing', body: '' })
      mkdirSync(join(workspace, 'nested'))
      writeFileSync(join(workspace, 'nested', 'old.md'), 'legacy mount')
      expect(
        (
          await ports.read({
            taskId: parent,
            archiveJson: null,
            content: 'old.md',
            kind: 'path<md>',
            fallbackWorkspaceRef: workspace,
            legacyRepoDirName: 'nested',
          })
        ).items[0],
      ).toMatchObject({ source: 'worktree', body: 'legacy mount', path: join('nested', 'old.md') })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('gate artifact storage reads staged then finalized content with unchanged manifest bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc395-a4-review-'))
    try {
      const taskId = ulid(),
        operationId = ulid()
      await seedTask(taskId, home)
      const body = '\ufeff# review\n中文\0'
      const artifacts = legacyReviewArtifacts(harness.db, home)
      const journal = new DatabaseHumanGateOperationJournal(
        composeHumanGateTaskLockPort,
        epoch2RuntimeTestPorts(harness.db).historyRestrictions,
      )
      const session = databaseSessionFor(harness.db)
      const plan = artifacts.planReviewArtifact({
        operationId,
        artifactKey: 'doc:0',
        // HEAD reviewVersions.ts: persisted POSIX path, independent of the new codec.
        finalPath: `runs/${taskId}/review/review/doc/round_${operationId}/item_0/v1.md`,
        body,
      })
      const manifest = JSON.stringify({
        schemaVersion: 2,
        kind: 'review-open',
        documents: [{ bodyPath: plan.finalPath }],
      })
      await session.transaction(async (tx) => {
        await journal.beginTx({
          tx,
          operationId,
          idempotencyKey: operationId,
          now: 1000,
          request: {
            schemaVersion: 1,
            taskId,
            gateKind: 'review',
            operationKind: 'open',
            gateRef: 'review:1',
            actorUserId: null,
            expectedTaskRevision: 0,
            expectedGateRevision: 0,
            payload: { kind: 'open', manifestDigest: 'source' },
          },
        })
        await journal.declareArtifactsTx({ tx, operationId, artifacts: [plan], now: 1001 })
      })
      const receiptJson = await artifacts.stageReviewArtifact(plan, body)
      await session.transaction(async (tx) => {
        await journal.transitionArtifactTx({
          tx,
          operationId,
          artifactKey: plan.artifactKey,
          from: 'declared',
          to: 'staged',
          receiptJson,
          now: 1002,
        })
        await journal.markPreparedTx({
          tx,
          operationId,
          expectedClaimEpoch: 1,
          manifestJson: manifest,
          now: 1003,
        })
        await journal.commitTx({
          tx,
          operationId,
          expectedClaimEpoch: 1,
          receiptJson: '{}',
          now: 1004,
        })
      })
      const reader = new DatabaseCommittedReviewArtifactReader(
        harness.db,
        createFileReviewArtifactContent(home),
        epoch2RuntimeTestPorts(harness.db).content,
      )
      expect(await reader.read(plan.finalPath)).toBe(body)
      const finalized = await artifacts.finalizeReviewArtifact({
        ...plan,
        artifactKind: 'review-doc',
        state: 'consumed',
        receiptJson,
        updatedAt: 1004,
      })
      expect(JSON.parse(finalized).finalPath).toBe(plan.finalPath)
      expect(readFileSync(join(home, plan.finalPath))).toEqual(Buffer.from(body))
      expect(await reader.read(plan.finalPath)).toBe(body)
      const saved = await session.transaction((tx) => journal.getTx(tx, operationId))
      expect(saved?.manifestJson).toBe(manifest)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
