// RFC-370: actual provider HTTP roots read the very content selection used by a
// drive writer, including after application reconstruction. No listener is opened.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { NodeRunPromptOperations } from '@/modules/task-execution/application/ports/nodeRunPromptContent'
import { bindTaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { describeEachProvider } from './helpers/eachProvider'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import { DESIGNER, freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { held, MemoryPortArtifactContent } from './helpers/portArtifactContent'
import { chosenTaskRuns, unusedTaskRunEffect } from './helpers/taskRunSelection'

describeEachProvider('RFC-370 real application root content coherence', (harness) => {
  test('drive writer references are readable through rebuilt root prompt and artifact APIs with selected ACKs', async () => {
    const taskId = freshTaskId(),
      nodeRunId = ulid()
    const appHome = mkdtempSync(join(tmpdir(), 'aw-root-content-'))
    const prompts = new Map<string, string>(),
      reads: string[] = []
    const entered = held<void>(),
      ack = held<void>()
    const bytes = Buffer.from('# complete selection\n正文')
    const content = new MemoryPortArtifactContent({
      read() {
        entered.resolve()
        return ack.promise
      },
    })
    const nodeRunPrompts: NodeRunPromptOperations = Object.freeze<NodeRunPromptOperations>({
      async store(receivedTask, receivedRun, text) {
        expect(this).toBe(nodeRunPrompts)
        const promptPath = 'object:prompt:' + receivedTask + '/' + receivedRun
        prompts.set(promptPath, text)
        return { promptText: null, promptPath }
      },
      async read(row) {
        expect(this).toBe(nodeRunPrompts)
        if (row === null || row === undefined) return null
        if (row.promptText !== null) return row.promptText
        if (row.promptPath === null) return null
        reads.push(row.promptPath)
        return prompts.get(row.promptPath) ?? null
      },
    })
    const portArtifacts = composePortArtifactOperations(content, appHome)
    const chosen = chosenTaskRuns({ nodeRunPrompts, portArtifacts })
    let application: Awaited<ReturnType<typeof createProviderHttpApplication>> | undefined
    let pending: Promise<Response> | undefined
    try {
      await seedTask(harness.db, taskId)
      await harness.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
      await harness.db.insert(nodeRuns).values({
        id: nodeRunId,
        taskId,
        nodeId: DESIGNER,
        status: 'done',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        startedAt: 1,
      })
      // The selected root exposes the drive's exact content operations. A later
      // HTTP root receives the same complete choice, with no native member fill.
      const root = bindTaskRunRootSelection(chosen.selection)
      const prompt = await root.nodeRunPrompts.store(taskId, nodeRunId, 'Selected root prompt 正文')
      await harness.db.update(nodeRuns).set(prompt).where(eq(nodeRuns.id, nodeRunId))
      const source = { workspaceRef: 'object:working:' + taskId, relativePath: 'report.md' }
      content.put(source, bytes)
      const archived = await root.portArtifacts.archive({
        taskId,
        nodeRunId,
        portName: 'report',
        worktreeDirName: '',
        items: [{ source, sourcePath: 'report.md' }],
      })
      await harness.db.insert(nodeRunOutputs).values({
        nodeRunId,
        portName: 'report',
        content: 'report.md',
        kind: 'path<md>',
        archiveJson: archived.archiveJson,
      })
      const input = {
        token: 'tok',
        appHome,
        configPath: join(appHome, 'config.json'),
        opencodeVersion: '1.14.25',
        dbVersion: 17,
        taskRunSelection: chosen.selection,
        // If a selected root accidentally composes legacy content again, this
        // complete unchosen receiver fails on the first observable effect.
        portArtifactContentEffects: {
          prepareArchive: unusedTaskRunEffect,
          reference: unusedTaskRunEffect,
          size: unusedTaskRunEffect,
          copy: unusedTaskRunEffect,
          readPrefix: unusedTaskRunEffect,
          write: unusedTaskRunEffect,
          linkTarget: unusedTaskRunEffect,
          readArchive: unusedTaskRunEffect,
          existsArchive: unusedTaskRunEffect,
          readWorkspace: unusedTaskRunEffect,
          existsWorkspace: unusedTaskRunEffect,
        },
      }
      application = await createProviderHttpApplication(harness, input)
      await application.dispose()
      application = await createProviderHttpApplication(harness, input)
      const headers = { Authorization: 'Bearer tok' }
      const session = await application.app.request(
        '/api/tasks/' + taskId + '/node-runs/' + nodeRunId + '/session',
        { headers },
      )
      expect(session.status).toBe(200)
      expect(JSON.stringify(await session.json())).toContain('Selected root prompt 正文')
      expect(reads).toEqual([prompt.promptPath!])
      content.calls.length = 0
      const path = '/api/tasks/' + taskId + '/port-artifacts/' + nodeRunId + '/report'
      let settled = false
      pending = Promise.resolve(application.app.request(path + '?item=0', { headers })).then(
        (response) => {
          settled = true
          return response
        },
      )
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error('HTTP ended before selected read: ' + response.status)
        }),
      ])
      expect(settled).toBe(false)
      expect(content.calls).toHaveLength(1)
      expect(content.calls[0]).toStartWith('read:object:')
      ack.resolve()
      const download = await pending
      expect(download.status).toBe(200)
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
      content.calls.length = 0
      const meta = await application.app.request(path, { headers })
      expect(meta.status).toBe(200)
      expect(await meta.json()).toEqual({
        items: [{ path: 'report.md', size: bytes.length, truncated: false, source: 'archive' }],
      })
      expect(content.calls).toHaveLength(1)
      expect(content.calls[0]).toStartWith('exists:object:')
      expect(chosen.agents).toEqual([])
      expect(chosen.scripts).toEqual([])
    } finally {
      ack.resolve()
      await pending
      await application?.dispose()
      rmSync(appHome, { recursive: true, force: true })
    }
  })
})
