// RFC-416: the hosted MCP diagnostic sessions are CrewStation infrastructure and composition runs each turn through
// the System Agent core. These cases lock the seam the move introduced: the session's invocation carries the original
// runner's workspace references, its prepare order (start admission before the `system-workspace` helper call) and its
// observation hook, and the binding hands exactly that invocation and its retained reference to the core.
import { expect, test } from 'bun:test'
import { createHostedMcpDiagnosticSessions } from '@/modules/task-execution/infrastructure/crewstation/mcpDiagnosticSessions'
import { createCrewStationMcpDiagnosticRunner } from '@/modules/task-execution/composition/crewstationMcpDiagnosticRunner'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'

const ROOT = `/work/system/shared/${sha256Hex('session-1')}`

function sessionInput(events: unknown[]) {
  return {
    reference: (taskId: string, path: string) => `ref:${taskId}:${path}`,
    helper: {
      async call(...args: unknown[]) {
        events.push(['helper', ...args])
        return {}
      },
    },
    workspaces: {
      ensure: async () => {
        throw new Error('rfc416-ensure-not-expected')
      },
      open: async () => null,
      close: async () => true,
    },
  } as never
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    intent: {} as never,
    beforeStart: async () => undefined,
    acknowledgeStarted: async () => undefined,
    ...overrides,
  }
}

test('the session invocation carries the original workspace references, prepare order and observation hook', async () => {
  const events: unknown[] = []
  const sessions = createHostedMcpDiagnosticSessions(sessionInput(events))
  const invocation = sessions.invocation(
    turn({ beforeStart: async () => void events.push('beforeStart') }),
    createLogger('rfc416'),
  )
  expect(sessions.workspaceReference('session-1')).toBe(`ref:mcp-test:session-1:${ROOT}`)
  expect(invocation.workspace.workspace).toEqual({
    owner: 'source-control',
    reference: `ref:mcp-test:session-1:${ROOT}/worktree`,
    version: null,
  })
  expect(invocation.workspace.runContent).toEqual({
    owner: 'runtime-management',
    reference: `ref:mcp-test:session-1:${ROOT}/run/turns/turn-1`,
    version: null,
  })
  expect(invocation.workspace.retainedRef).toBe(sessions.workspaceReference('session-1'))
  expect(invocation.acknowledgeStart()).toBe(true)
  expect('observe' in invocation).toBe(false)
  await invocation.prepareWorkspace()
  expect(events).toEqual([
    'beforeStart',
    [
      'helper',
      'mcp-test:session-1',
      'system-workspace',
      { method: 'prepare', namespace: 'shared', key: sha256Hex('session-1'), seeds: [] },
      { operationId: 'mcp:turn-1:prepare' },
    ],
  ])
  const observe = async () => ({}) as never
  expect(sessions.invocation(turn({ observe }), createLogger('rfc416')).observe).toBe(observe)
})

test('the binding runs the turn through the System Agent core with the session retained reference', async () => {
  const events: unknown[] = []
  const runner = createCrewStationMcpDiagnosticRunner(sessionInput(events))
  expect(Object.keys(runner).sort()).toEqual([
    'cleanup',
    'hasExecution',
    'run',
    'settled',
    'workspaceExists',
    'workspaceReference',
  ])
  const result = await runner.run({
    ...turn({
      beforeStart: async () => {
        throw new Error('rfc416-sentinel')
      },
    }),
    policy: { feature: 'mcp-test' },
    timeoutMs: 1_000,
    maxEventTextBytes: 1_024,
  })
  expect(result.status).toBe('spawn-failed')
  expect(result.retainedRef).toBe(runner.workspaceReference('session-1'))
  expect(result.stderrTail).toContain('scratch setup failed: rfc416-sentinel')
  expect(events).toEqual([])
})
