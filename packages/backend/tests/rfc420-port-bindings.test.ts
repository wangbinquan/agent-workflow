// RFC-420: the residual logic of the execution state bindings moved out of task-execution composition. These cases
// lock the moved bodies on their new owners: the closure port read (visible / captured / not visible), the prior
// fan-out provenance, the fan-out agent and source-port-kind resolution, the wrapper body's mounts and entry order,
// the call node's delegated actor and child runtime, the call row's iso rebuild order and the collaborator projection.
import { expect, test } from 'bun:test'
import { encodeConsumedEdges } from '@/modules/task-execution/domain/consumedInputs'
import { TOP_FRAME } from '@/modules/task-execution/domain/environmentChain'
import { nodeOutputSlot } from '@/modules/task-execution/domain/runSelection/nodeOutputSlot'
import { collaboratorUserIdsOf } from '@/modules/task-execution/domain/taskCollaborators'
import {
  priorFanoutConsumedJson,
  readPortInScope,
} from '@/modules/task-execution/application/nodeInputs'
import {
  resolveFanoutAgent,
  sourcePortKindOf,
} from '@/modules/task-execution/application/fanoutAgentResolution'
import {
  buildChildRuntime,
  delegatedCallActor,
} from '@/modules/task-execution/application/childCallInheritance'
import { pickInheritableRunConfig } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import {
  createWrapperScopeDriver,
  wrapperBodyMounts,
} from '@/modules/task-execution/engine/wrapper/wrapperBodyScope'
import { restoreNodeIso } from '@/modules/task-execution/engine/kernel/mergeRecovery'
import { declaredPorts } from '@agent-workflow/shared'

function portPersistence(input: {
  readonly containerRows?: Record<string, Record<string, unknown>>
  readonly runs: readonly { readonly id: string; readonly status: string }[]
  readonly outputs: readonly Record<string, unknown>[]
}) {
  const slots: unknown[] = []
  const persistence = {
    read: async (id: string) => input.containerRows?.[id] ?? null,
    snapshotRead: async (fn: (snapshot: unknown) => Promise<unknown>) =>
      fn({
        list: async () => input.runs,
        selection: {
          slotHistory: async (_taskId: string, slot: unknown) => {
            slots.push(slot)
            return input.runs
          },
        },
      }),
    listOutputs: async () => input.outputs,
  }
  return { persistence: persistence as never, slots }
}

const ANSWER = {
  portName: 'answer',
  content: 'yes',
  kind: 'string',
  archiveJson: null,
  active: true,
}

test('a closure port read resolves the source frame and reads the settled row there', async () => {
  const definition = {
    nodes: [
      { id: 'outer', kind: 'agent-single' },
      { id: 'loop', kind: 'wrapper-loop' },
      { id: 'body', kind: 'agent-single' },
    ],
    edges: [],
  } as never
  const parents = new Map([['body', 'loop']])
  const top = portPersistence({ runs: [{ id: 'run-1', status: 'done' }], outputs: [ANSWER] })
  expect(
    await readPortInScope(
      { persistence: top.persistence, taskId: 't', definition, parents },
      'outer',
      'answer',
      TOP_FRAME,
    ),
  ).toEqual({ runId: 'run-1', content: 'yes', kind: 'string', archiveJson: null, active: true })
  expect(top.slots).toEqual([nodeOutputSlot('outer', 'agent-single', TOP_FRAME)])

  // A body frame reads a node outside the loop as a captured free variable, one generation row outward.
  const captured = portPersistence({
    containerRows: { 'gen-1': { id: 'gen-1', nodeId: 'loop', containerRunId: null, iteration: 0 } },
    runs: [{ id: 'run-2', status: 'done' }],
    outputs: [ANSWER],
  })
  await readPortInScope(
    { persistence: captured.persistence, taskId: 't', definition, parents },
    'outer',
    'answer',
    { containerRunId: 'gen-1', iteration: 2 },
  )
  expect(captured.slots).toEqual([nodeOutputSlot('outer', 'agent-single', TOP_FRAME)])

  // A body node is not visible from the top frame: the read fails loudly instead of reading ''.
  const hidden = portPersistence({ runs: [], outputs: [] })
  await expect(
    readPortInScope(
      { persistence: hidden.persistence, taskId: 't', definition, parents },
      'body',
      'answer',
      TOP_FRAME,
    ),
  ).rejects.toThrow(
    "closure-binding-unresolved: port 'body.answer' is not visible from frame top#0 (scope-not-enclosing at loop)",
  )
  expect(hidden.slots).toEqual([])
})

test('the prior fan-out provenance excludes the asking attempt and encodes the newest consumed record', async () => {
  const calls: unknown[] = []
  const edges = [{ producerNodeId: 'src', producerRunId: 'src-run' }]
  const persistence = (history: readonly { readonly id: string }[]) =>
    ({
      snapshotRead: async (fn: (snapshot: unknown) => Promise<unknown>) =>
        fn({
          list: async (query: unknown) => {
            calls.push(['list', query])
            return [{ id: 'a' }, { id: 'self' }, { id: 'b' }]
          },
          selection: {
            familyHistory: async (...args: unknown[]) => {
              calls.push(['familyHistory', ...args])
              return history
            },
            consumed: async (id: string) => {
              calls.push(['consumed', id])
              return edges
            },
          },
        }),
    }) as never
  expect(
    await priorFanoutConsumedJson(persistence([{ id: 'a' }, { id: 'b' }]), 't', 'fan', 3, 'self'),
  ).toBe(encodeConsumedEdges(edges))
  expect(calls).toEqual([
    ['list', { taskId: 't', nodeId: 'fan', iteration: 3 }],
    [
      'familyHistory',
      't',
      { nodeId: 'fan', iteration: 3, runIds: ['a', 'b'] },
      { topLevelOnly: true, consumedOnly: true },
    ],
    ['consumed', 'b'],
  ])
  calls.length = 0
  expect(await priorFanoutConsumedJson(persistence([]), 't', 'fan', 3, 'self')).toBeNull()
  expect(calls.map((call) => (call as unknown[])[0])).toEqual(['list', 'familyHistory'])
})

function agentResources(injection: (agentId: string) => Promise<unknown>) {
  const keys: unknown[] = []
  const injected: string[] = []
  return {
    keys,
    injected,
    resources: {
      definition: {
        nodes: [
          { id: 'src', kind: 'agent-single', agentId: 'agent-1' },
          { id: 'named', kind: 'agent-single', agentName: 'legacy' },
          { id: 'git', kind: 'wrapper-git' },
        ],
        edges: [],
      } as never,
      agentKey(node: Record<string, unknown>) {
        keys.push(node.id)
        return typeof node.agentId === 'string' ? node.agentId : null
      },
      async injection(agentId: string) {
        injected.push(agentId)
        return (await injection(agentId)) as never
      },
    },
  }
}

test('a fan-out agent resolves by its canonical key; failures come back as data', async () => {
  const agent = { id: 'agent-1', outputKinds: { items: 'list<string>' } }
  const ok = agentResources(async () => ({ kind: 'ok', spec: { agent } }))
  expect(
    await resolveFanoutAgent(ok.resources, { id: 'named', kind: 'agent-single' } as never),
  ).toEqual({
    kind: 'missing',
  })
  expect(ok.injected).toEqual([])
  expect(
    await resolveFanoutAgent(ok.resources, { id: 'src', agentId: 'agent-1' } as never),
  ).toEqual({ kind: 'ok', agent } as never)
  const failure = { kind: 'failed', summary: 'gone', message: 'agent-not-found' }
  const failed = agentResources(async () => failure)
  expect(
    await resolveFanoutAgent(failed.resources, { id: 'src', agentId: 'agent-1' } as never),
  ).toBe(failure as never)
})

test('a source port kind: an agent from the session, every other kind from the port table', async () => {
  const agent = { id: 'agent-1', outputKinds: { items: 'list<string>' } }
  const { resources, injected } = agentResources(async () => ({ kind: 'ok', spec: { agent } }))
  expect(await sourcePortKindOf(resources, 'src', 'items')).toBe('list<string>')
  expect(await sourcePortKindOf(resources, 'src', 'other')).toBeNull()
  expect(await sourcePortKindOf(resources, 'named', 'items')).toBeNull()
  expect(injected).toEqual(['agent-1', 'agent-1'])
  const declared = declaredPorts(
    { id: 'git', kind: 'wrapper-git' } as never,
    resources.definition,
    {},
  ).dataOutputs.find((port) => port.name === 'git_diff')?.kind
  expect(declared).toBeDefined()
  expect(await sourcePortKindOf(resources, 'git', 'git_diff')).toBe(declared!)
  expect(await sourcePortKindOf(resources, 'missing', 'items')).toBeNull()
  expect(injected).toHaveLength(2)
  const failed = agentResources(async () => ({ kind: 'failed', summary: 's', message: 'm' }))
  expect(await sourcePortKindOf(failed.resources, 'src', 'items')).toBeNull()
})

const OUTER = [
  {
    ordinal: 0,
    repoPath: '/repo',
    worktreePath: '/task',
    mountPath: 'app',
    readonly: true,
    baseBranch: 'main',
    baseCommit: 'c0',
    extra: 'kept',
  },
] as never

function isoHandle(passthrough: boolean) {
  return {
    passthrough,
    containerPath: '/iso/container',
    repos: [
      {
        repoPath: '/repo',
        isoWorktreePath: '/iso/app',
        mountPath: 'iso-mount',
        baseBranch: 'iso-branch',
        baseSnapshot: 'snap',
      },
    ],
  } as never
}

test('a wrapper body runs in place when passthrough; a loop keeps outer mounts, a git body uses the iso', () => {
  expect(wrapperBodyMounts(OUTER, isoHandle(true), 'wrapper-loop')).toBeNull()
  const shared = {
    ordinal: 0,
    repoPath: '/repo',
    worktreePath: '/iso/app',
    baseBranch: 'iso-branch',
    baseCommit: 'snap',
    extra: 'kept',
  }
  expect(wrapperBodyMounts(OUTER, isoHandle(false), 'wrapper-loop')).toEqual({
    repos: [{ ...shared, mountPath: 'app', readonly: true }],
    scopeRoot: '/iso/container',
  } as never)
  expect(wrapperBodyMounts(OUTER, isoHandle(false), 'wrapper-git')).toEqual({
    repos: [{ ...shared, mountPath: 'iso-mount', readonly: false }],
    scopeRoot: '/iso/container',
  } as never)
})

function scopeDriverFixture(passthrough: boolean, kind: 'wrapper-loop' | 'wrapper-git') {
  const calls: unknown[] = []
  const outer = { name: 'outer' }
  const logs: string[] = []
  const log = {
    child(name: string) {
      logs.push(name)
      return { name } as never
    },
  } as never
  const driver = createWrapperScopeDriver<Record<string, unknown>>(
    {
      outer,
      outerRepos: OUTER,
      resolve: (scene) => {
        calls.push(['resolve', scene])
        return { handle: isoHandle(passthrough), kind }
      },
      enter: (mounts) => ({ name: 'inner', mounts }),
      completeMerges: async (state, frame, scopeLog) => {
        calls.push(['completeMerges', state.name, frame, scopeLog])
      },
      drive: async (state, args) => {
        calls.push(['drive', state.name, { ...args, scopeIds: [...args.scopeIds] }])
        return { kind: 'ok' } as never
      },
    },
    log,
  )
  return { driver, calls, logs }
}

const DRIVE_INPUT = {
  scope: { wrapperId: 'loop', directNodeIds: ['a', 'b'] },
  containerRunId: 'gen-1',
  iteration: 2,
  workspace: { key: Symbol('scene'), kind: 'wrapper-loop', passthrough: false },
} as never

test('a wrapper body first completes its interrupted merges, then drives its scope under the body log', async () => {
  const { driver, calls, logs } = scopeDriverFixture(false, 'wrapper-loop')
  expect(await driver.drive(DRIVE_INPUT)).toEqual({ kind: 'ok' } as never)
  expect(logs).toEqual(['loop:loop'])
  expect(calls).toEqual([
    ['resolve', (DRIVE_INPUT as { workspace: unknown }).workspace],
    ['completeMerges', 'inner', { containerRunId: 'gen-1', iteration: 2 }, { name: 'loop:loop' }],
    [
      'drive',
      'inner',
      {
        scopeId: 'loop',
        scopeIds: ['a', 'b'],
        containerRunId: 'gen-1',
        iteration: 2,
        log: { name: 'loop:loop' },
      },
    ],
  ])
  const git = scopeDriverFixture(true, 'wrapper-git')
  await git.driver.drive(DRIVE_INPUT)
  expect(git.logs).toEqual(['git:loop'])
  // Passthrough: the body runs in the outer state.
  expect((git.calls[1] as unknown[])[1]).toBe('outer')
  expect((git.calls[2] as unknown[])[1]).toBe('outer')
})

test('a NULL owner launches as the permissionless legacy actor; any other owner through forCall', async () => {
  const requests: unknown[] = []
  const delegated = {
    forCall: async (input: { ownerUserId: string }) => {
      requests.push(input)
      return input.ownerUserId === 'gone' ? null : { actor: { user: { id: input.ownerUserId } } }
    },
  } as never
  const input = {
    kind: 'call-workflow',
    parentTaskId: 'parent',
    parentNodeRunId: 'call-run',
  } as const
  const legacy = await delegatedCallActor(delegated, { ...input, ownerUserId: null })
  expect(legacy?.user.id).toBe('__system__')
  expect(legacy?.source).toBe('daemon')
  expect(legacy?.permissions.size).toBe(0)
  expect(Object.isFrozen(legacy)).toBe(true)
  expect(requests).toEqual([])
  expect((await delegatedCallActor(delegated, { ...input, ownerUserId: 'owner-1' }))?.user.id).toBe(
    'owner-1',
  )
  expect(requests).toEqual([{ ...input, ownerUserId: 'owner-1' }])
  expect(await delegatedCallActor(delegated, { ...input, ownerUserId: 'gone' })).toBeNull()
})

test('a child runtime carries the trigger context only when present, the owner and the inheritable config', () => {
  const opts = { appHome: '/home', maxConcurrentNodes: 3, taskId: 'not-inherited' } as never
  expect(
    buildChildRuntime({ triggerContext: null, task: { ownerUserId: 'owner-1' }, opts }),
  ).toEqual({ actorUserId: 'owner-1', runConfig: pickInheritableRunConfig(opts) })
  const triggerContext = { kind: 'webhook' } as never
  const withTrigger = buildChildRuntime({ triggerContext, task: { ownerUserId: null }, opts })
  expect(withTrigger.triggerContext).toBe(triggerContext)
  expect(withTrigger.actorUserId).toBeUndefined()
  expect('actorUserId' in withTrigger).toBe(true)
})

test('a call row iso is rebuilt in the replay order: scope, task heads, recovery key, restore', async () => {
  const calls: unknown[] = []
  const handle = { nodeRunId: 'call-run' }
  const ports = {
    taskId: 'task-1',
    repos: [
      { worktreePath: '/task/a', mountPath: 'a' },
      { worktreePath: '/task/b', mountPath: 'b' },
    ],
    workspace: {
      scope: async () => {
        calls.push('scope')
        return {
          head: async (path: string) => {
            calls.push('head:' + path)
            return { stdout: 'head-' + path + '\n', stderr: '', exitCode: 0 }
          },
          recoverKey: async (ref: string | null, id: string) => {
            calls.push('recoverKey:' + String(ref) + ':' + id)
            return 'key-' + id
          },
        }
      },
      restore: async (request: Record<string, unknown>) => {
        calls.push(['restore', request])
        return handle
      },
    },
    persistence: {
      artifactPaths: {
        forcedPaths: async (taskId: string) => {
          calls.push('forcedPaths:' + taskId)
          return ['.agent-workflow/out.txt']
        },
      },
    },
  } as never
  const submodules = { subBases: { vendor: 'sub-base' }, poolDirs: {} }
  const checkpoints = [
    { mountPath: 'a', submodules },
    { mountPath: 'b', submodules: null },
  ] as never
  expect(
    await restoreNodeIso(ports, {
      nodeRunId: 'call-run',
      workspaceRef: '/iso/call',
      baseSnapshots: { a: 'snap-a' },
      checkpoints,
    }),
  ).toBe(handle as never)
  expect(calls).toEqual([
    'scope',
    'head:/task/a',
    'head:/task/b',
    'recoverKey:/iso/call:call-run',
    'forcedPaths:task-1',
    [
      'restore',
      {
        key: 'key-call-run',
        dbNodeRunId: 'call-run',
        workspaceRef: '/iso/call',
        baseSnapshots: { a: 'snap-a' },
        taskBaseHeads: { a: 'head-/task/a', b: 'head-/task/b' },
        submodules: { a: { ...submodules, pendingSubResolves: [] } },
        forcedContainerPaths: ['.agent-workflow/out.txt'],
      },
    ],
  ])
})

test('collaborators leave out the owner and rows without a user, keeping first occurrences', () => {
  expect(
    collaboratorUserIdsOf([
      { userId: 'owner-1', role: 'owner' },
      { userId: 'u2', role: 'collaborator' },
      { userId: null, role: 'collaborator' },
      { userId: 'u3', role: 'collaborator' },
      { userId: 'u2', role: 'collaborator' },
    ]),
  ).toEqual(['u2', 'u3'])
  expect(collaboratorUserIdsOf([])).toEqual([])
})
