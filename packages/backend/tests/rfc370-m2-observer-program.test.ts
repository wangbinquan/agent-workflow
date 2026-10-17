// RFC-370 M2: execute the existing observer envelope policy on task-image
// scripts; preserve its stable request identity and unknown-writer retention.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCrewStationObserverProgramFactory } from '@/modules/event-center/composition'
import { executeWorkspaceTaskImageOperation } from '@/bootstrap/workspaceTaskImage'
import { executeCustomObserverProgram } from '@/modules/event-center/application/customObserverProgram'
import { customEventSourceDraftSchema } from '@/modules/event-center/domain/customEventSource'
import type {
  CustomObserverProgramInput,
  CustomObserverProgramResult,
} from '@/modules/event-center/application/ports/customObserverProgram'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'

function input(source?: string): CustomObserverProgramInput {
  const draft = customEventSourceDraftSchema.parse({
    schemaVersion: 1,
    displayName: { 'zh-CN': '远程观察器', 'en-US': 'Remote observer' },
    description: { 'zh-CN': '协议测试', 'en-US': 'Protocol fixture' },
    pollIntervalMs: 1000,
    batchSize: 20,
    ingestionMode: 'state-change',
    program: {
      language: 'node',
      timeoutMs: 1000,
      source:
        source ??
        `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(process.env.AW_EVENT_INPUT_FILE, 'utf8'));
      console.log(JSON.stringify({protocol: process.env.AW_EVENT_OBSERVER_PROTOCOL, cursor: {next: 2},
        observations: input.subjects.map(subject => ({eventKey: 'issue.changed', subjectRef: subject.subjectRef,
          occurredAt: '2026-10-15T00:00:00.000Z', sourceEventKey: subject.subjectRef, sourceEventRevision: '2', summary: 'Changed'}))}));
    `,
    },
    eventTypes: [
      {
        eventKey: 'issue.changed',
        subjectTypeId: 'issue',
        payloadSchemaId: 'event.summary',
        displayName: { 'zh-CN': '变更', 'en-US': 'Changed' },
        description: { 'zh-CN': '变更', 'en-US': 'Changed' },
        deliveryClass: 'issue.change',
      },
    ],
    fixture: { subjects: [{ typeId: 'issue', subjectRef: 'ISSUE-1' }], cursorJson: null },
  })
  return {
    sourceRef: { id: 'source', revision: 1 },
    draft,
    subjects: draft.fixture.subjects,
    cursorJson: null,
    now: Date.parse('2026-10-15T00:00:00.000Z'),
  }
}

test('hosted observer runs the real task-image script and the common policy owns cursor and subject validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-observer-'))
  const keys: string[] = []
  const receipts = new Map<string, unknown>()
  let launches = 0
  const helper: WorkspaceHelper = {
    async call<T>(
      taskId: string,
      operation: string,
      value: unknown,
      options?: Parameters<WorkspaceHelper['call']>[3],
    ): Promise<T> {
      expect(taskId).toBe('observer:source')
      const key = options?.operationId
      if (operation === 'observer-run') {
        expect(options?.timeoutMs).toBe(31_000)
        keys.push(key!)
      }
      if (key && receipts.has(key)) return receipts.get(key) as T
      if (operation === 'observer-run') launches++
      const result = await executeWorkspaceTaskImageOperation(operation, value, undefined, root)
      if (key) receipts.set(key, result)
      return result as T
    },
  }
  try {
    const request = input()
    const first = await executeCustomObserverProgram(
      createCrewStationObserverProgramFactory(helper),
      request,
    )
    const replay = await executeCustomObserverProgram(
      createCrewStationObserverProgramFactory(helper),
      request,
    )
    expect(replay).toEqual(first)
    expect(first.batch.cursorJson).toBe('{"next":2}')
    expect(first.batch.observations).toHaveLength(1)
    expect(first.batch.observations[0]!.subject.subjectRef).toBe('ISSUE-1')
    expect(keys[0]).toBe(keys[1])
    expect(launches).toBe(1)
    expect(readdirSync(join(root, 'observers'))).toEqual([])
    await expect(
      executeCustomObserverProgram(
        createCrewStationObserverProgramFactory(helper),
        input('console.log("not json")'),
      ),
    ).rejects.toThrow('exactly one JSON envelope')
    expect(readdirSync(join(root, 'observers'))).toEqual([])
    const timedOut = input('setInterval(() => {}, 1000)')
    await expect(
      executeCustomObserverProgram(createCrewStationObserverProgramFactory(helper), timedOut),
    ).rejects.toThrow('observer script failed: timeout')
    expect(readdirSync(join(root, 'observers'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

for (const state of ['unknown', 'child-unkillable'] as const) {
  test(`hosted observer ${state} never disposes a possibly live workspace`, async () => {
    const calls: string[] = []
    const helper: WorkspaceHelper = {
      async call<T>(_taskId: string, operation: string): Promise<T> {
        calls.push(operation)
        if (operation === 'observer-resolve') return true as T
        if (operation === 'observer-run') {
          if (state === 'unknown') throw new Error('original execution outcome unknown')
          return {
            outcome: state,
            exitCode: null,
            stderrTail: '',
            rawStdout: '',
            truncated: { stdout: false },
          } satisfies CustomObserverProgramResult as T
        }
        throw new Error('unsafe cleanup attempted')
      },
    }
    await expect(
      executeCustomObserverProgram(createCrewStationObserverProgramFactory(helper), input()),
    ).rejects.toThrow()
    expect(calls).toEqual(['observer-resolve', 'observer-run'])
  })
}

test('observer task-image disposal rejects references outside its owned directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-hosted-observer-boundary-'))
  try {
    await expect(
      executeWorkspaceTaskImageOperation('observer-dispose', { id: '../outside' }, undefined, root),
    ).rejects.toThrow('workspace-invalid')
    expect(existsSync(root)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
