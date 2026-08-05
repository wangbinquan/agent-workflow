// RFC-224 T12-T18 — the hidden launcher must preserve ordering and cleanup at
// the process/API boundary. These tests inject the server/client only; the
// production manifest parser, codec, marker and lifecycle decisions remain
// under test.

import { afterEach, describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { SEALED_SHELL_SUPPORTED } from '@/util/platformExec'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ROOT_SESSION_PERMISSION_RULES,
  type GlobalSessionInfo,
  type PromptRequest,
  type SessionInfo,
  type WireEvent,
  type WithParts,
  OPENCODE_DIRECT_PROTOCOL_CODEC,
} from '@/services/runtime/opencode/directApiSchemas'
import {
  businessOpencodeIdentityDigest,
  identityDigest,
} from '@/services/runtime/opencode/executionIdentity'
import {
  launchVerifiedOpencodeManifest,
  runVerifiedOpencodeLauncher,
  verifyPinnedSkillInventory,
} from '../src/services/runtime/opencode/verifiedLauncher'
import { PINNED_BUILTIN_SKILL } from '../src/services/runtime/opencode/hermetic'
import {
  verifySelectedProviderInventory,
  type VerifiedLauncherClient,
  type VerifiedLauncherDependencies,
  type VerifiedLauncherServerProcess,
} from '@/services/runtime/opencode/verifiedLauncher'
import {
  VerifiedLaunchManifestSchema,
  type VerifiedLaunchManifest,
} from '@/services/runtime/opencode/verifiedManifest'
import { parseControlLine } from '@/services/runtime/opencode/controlProtocol'
import type { OpencodeStoreLifecycleLock } from '@/services/runtime/opencode/storeHygiene'
import { containmentRequirementDigest } from '@/services/sandbox'
import type { InventorySnapshotCaptured } from '@agent-workflow/shared'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function id(prefix: 'ses' | 'msg' | 'prt' | 'evt', time: number, counter = 1): string {
  const encoded = (BigInt(time) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0')
  return `${prefix}_${encoded}${'A'.repeat(14)}`
}

const sessionID = id('ses', 1)
const model = { providerID: 'openai', modelID: 'gpt-5.6' }
// RFC-254 T32: host-canonical fixture roots. The manifest schema demands
// canonical absolute paths (`resolve(v) === v`), and the old POSIX literals
// (`/private/rfc224/...`) pass `isAbsolute` on Windows but fail the round-trip
// (`resolve` prefixes the drive), so EVERY test in this file died in fixture
// construction there — the largest single cluster in the first full Windows
// inventory. The validator is right; only the spelling was unportable. The
// structural relationships (seal/probe/ack under runRoot; the outside-run-root
// negative case staying OUTSIDE it) are preserved by construction.
const FIXTURE_ROOT = resolve(tmpdir(), 'aw-rfc224-fixture')
const RUN_ROOT = join(FIXTURE_ROOT, 'run')
const STORE_ROOT = join(FIXTURE_ROOT, 'store')
const worktreePath = join(FIXTURE_ROOT, 'worktree')
const SEAL_ROOT = join(RUN_ROOT, 'opencode-identity-seal')
const BWRAP_PATH = canonicalBinaryPath('bwrap')
const sourceDigest = 'b'.repeat(64)
const buildDigest = 'a'.repeat(64)

function contract(title: string) {
  return {
    directory: worktreePath,
    path: '',
    title,
    agent: 'worker',
    model,
    permission: ROOT_SESSION_PERMISSION_RULES,
    parentID: null,
    workspaceID: null,
    share: null,
    revert: null,
    metadata: null,
  }
}

function commonManifest(title: string) {
  const expectedConfig = {
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    compaction: { auto: false },
    // RFC-254 T13: the sealed-shell key is a PLATFORM fact of the controlled
    // config — POSIX seals a shell, win32 declares none, and the identity
    // check treats absence as identity too. The fixture must describe the
    // config THIS host's identity rules expect, or every business-manifest
    // test dies in `businessOpencodeIdentityDigest` (`/config/shell`) before
    // asserting anything.
    ...(SEALED_SHELL_SUPPORTED ? { shell: join(SEAL_ROOT, 'shell', 'sh') } : {}),
    instructions: [],
    skills: { paths: [], urls: [] },
    plugin: [],
    mcp: {},
    permission: {
      question: 'deny',
      plan_enter: 'deny',
      plan_exit: 'deny',
    },
    agent: {
      worker: {
        prompt: 'persona',
        description: 'worker',
        model: 'openai/gpt-5.6',
        mode: 'primary',
        hidden: false,
        permission: {
          bash: 'deny',
          read: 'deny',
          edit: 'deny',
          write: 'deny',
          apply_patch: 'deny',
          grep: 'deny',
          glob: 'deny',
          skill: 'deny',
          task: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          lsp: 'deny',
          external_directory: {
            '/private/store/tool-output/*': 'deny',
            '*': 'deny',
          },
        },
        options: {},
      },
    },
  }
  return {
    codec: 4 as const,
    protocolCodec: OPENCODE_DIRECT_PROTOCOL_CODEC,
    binaryPath: canonicalBinaryPath('opencode'),
    binaryDigest: buildDigest,
    containmentAdmission: {
      coordinatorBootId: 'rfc224-test-boot',
      admissionGeneration: 1,
      policyGeneration: 1,
      probeGeneration: 1,
      probeCheckedAt: 1,
      providerId: 'linux-bwrap',
      profileId: 'model-child-netless-v1' as const,
      requirementDigest: containmentRequirementDigest('model-child-netless-v1'),
      mode: 'enforce' as const,
      decision: 'contained' as const,
      requiredCapabilities: [
        'platformHomeIsolation',
        'immutableArtifactView',
        'modelChildNetworkDeny',
      ],
      capabilities: {
        platformHomeIsolation: 'strong' as const,
        immutableArtifactView: 'strong' as const,
        modelChildNetworkDeny: 'strong' as const,
        descendantLifetimeBound: 'strong' as const,
      },
      reasonCodes: [],
      admittedAt: 1,
    },
    containmentTopology: 'runner-outer-and-child' as const,
    containment: {
      providerId: 'linux-bwrap',
      mode: 'enforce' as const,
      capabilities: {
        platformHomeIsolation: 'strong' as const,
        immutableArtifactView: 'strong' as const,
        modelChildNetworkDeny: 'strong' as const,
        descendantLifetimeBound: 'strong' as const,
      },
      available: true,
      degradedReasons: [],
    },
    childProvider: {
      providerId: 'linux-bwrap',
      config: { bwrapPath: BWRAP_PATH },
    },
    worktreePath,
    runRoot: RUN_ROOT,
    sessionDbPath: join(STORE_ROOT, 'xdg-data', 'opencode', 'opencode.db'),
    sessionStoreKey: 'store_0123456789abcdef',
    serverEnv: {
      HOME: join(STORE_ROOT, 'home'),
      PWD: worktreePath,
      XDG_DATA_HOME: join(STORE_ROOT, 'xdg-data'),
      OPENCODE_SERVER_USERNAME: 'aw-user',
      OPENCODE_SERVER_PASSWORD: 'server-secret',
    },
    expectedConfig,
    selectedAgent: 'worker',
    selectedModel: model,
    prompt: 'do the work',
    sourceFingerprintDigest: sourceDigest,
    sessionTitle: title,
    sessionContractDigest: identityDigest(contract(title)),
    identityDigest: identityDigest({
      codec: 1,
      config: expectedConfig,
      agent: 'worker',
      model,
      binaryDigest: buildDigest,
    }),
    fffCapabilityCodec: 1 as const,
    fffProbe: {
      root: join(RUN_ROOT, 'fff-probe'),
      basename: 'aw-fff-0123456789abcdef0123456789abcdef.txt',
      fileDigest: 'f'.repeat(64),
      bwrapPath: BWRAP_PATH,
    },
    bootstrapTimeoutMs: 1_000,
    runTimeoutMs: 1_000,
  }
}

function systemManifest(): VerifiedLaunchManifest {
  return VerifiedLaunchManifestSchema.parse({
    ...commonManifest('agent-workflow:system:invocation-1'),
    storeKind: 'system-ephemeral',
    mode: 'new',
    invocationId: 'invocation-1',
  })
}

function businessManifest(): VerifiedLaunchManifest {
  const leaseNonce = 'N'.repeat(43)
  const common = commonManifest('agent-workflow:run-1')
  return VerifiedLaunchManifestSchema.parse({
    ...common,
    identityDigest: businessOpencodeIdentityDigest({
      config: common.expectedConfig,
      agent: common.selectedAgent,
      model: common.selectedModel,
      binaryDigest: common.binaryDigest,
      sealRoot: SEAL_ROOT,
    }),
    storeKind: 'business',
    mode: 'new',
    createdNodeRunId: 'run-1',
    nodeRunId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    controlAckPath: join(RUN_ROOT, 'control.ack'),
    leaseNonce,
    leaseNonceDigest: createHash('sha256').update(leaseNonce).digest('hex'),
    inventory: { enabled: false },
  })
}

function resumeManifest(): VerifiedLaunchManifest {
  const leaseNonce = 'R'.repeat(43)
  const common = commonManifest('agent-workflow:run-1')
  return VerifiedLaunchManifestSchema.parse({
    ...common,
    identityDigest: businessOpencodeIdentityDigest({
      config: common.expectedConfig,
      agent: common.selectedAgent,
      model: common.selectedModel,
      binaryDigest: common.binaryDigest,
      sealRoot: SEAL_ROOT,
    }),
    storeKind: 'business',
    mode: 'resume',
    expectedSessionId: sessionID,
    expectedProjectId: 'project-1',
    createdNodeRunId: 'run-1',
    nodeRunId: 'run-2',
    taskId: 'task-1',
    nodeId: 'node-1',
    controlAckPath: join(RUN_ROOT, 'control.ack'),
    leaseNonce,
    leaseNonceDigest: createHash('sha256').update(leaseNonce).digest('hex'),
    inventory: { enabled: false },
  })
}

function mcpTestManifest(mode: 'new' | 'resume' = 'new'): VerifiedLaunchManifest {
  const leaseNonce = 'M'.repeat(43)
  const testSessionId = 'mcp-test-session-1'
  const turnId = mode === 'new' ? 'mcp-test-turn-1' : 'mcp-test-turn-2'
  const mcpExecutionDigest = 'f'.repeat(64)
  const common = commonManifest(`agent-workflow:rfc238:mcp-test:${testSessionId}`)
  return VerifiedLaunchManifestSchema.parse({
    ...common,
    identityDigest: identityDigest({
      codec: 1,
      storeKind: 'mcp-test',
      testSessionId,
      sessionStoreKey: common.sessionStoreKey,
      agent: common.selectedAgent,
      model: common.selectedModel,
      binaryDigest: common.binaryDigest,
      mcpExecutionDigest,
    }),
    storeKind: 'mcp-test',
    mode,
    testSessionId,
    createdTurnId: 'mcp-test-turn-1',
    turnId,
    ...(mode === 'resume'
      ? {
          expectedSessionId: sessionID,
          expectedProjectId: 'project-1',
        }
      : {}),
    controlAckPath: join(RUN_ROOT, 'mcp-test-control.ack'),
    leaseNonce,
    leaseNonceDigest: createHash('sha256').update(leaseNonce).digest('hex'),
    mcpExecutionDigest,
  })
}

function session(title: string): SessionInfo {
  return {
    id: sessionID,
    slug: 'quiet-moon',
    projectID: 'project-1',
    directory: worktreePath,
    path: '',
    title,
    agent: 'worker',
    model: { providerID: 'openai', id: 'gpt-5.6' },
    version: '1.18.3',
    time: { created: 1, updated: 1 },
    permission: ROOT_SESSION_PERMISSION_RULES.map((rule) => ({ ...rule })),
  }
}

function wire(type: string, properties: Record<string, unknown>, counter: number): WireEvent {
  return {
    id: id('evt', 1, counter),
    type,
    properties,
  } as WireEvent
}

class FakeClient implements VerifiedLauncherClient {
  readonly calls: string[] = []
  readonly title: string
  posted: PromptRequest | undefined
  aborts = 0

  constructor(title: string) {
    this.title = title
  }

  // RFC-251: no getConfig stub — the launcher no longer reads /config, and
  // keeping a recording stub here would let a re-introduced read go unnoticed
  // in the `calls` assertions.

  async getConfigProviders(): Promise<unknown> {
    this.calls.push('providers')
    return {}
  }

  async getAgents(): Promise<unknown> {
    this.calls.push('agents')
    return []
  }

  async getSkills(): Promise<unknown> {
    this.calls.push('skills')
    return []
  }

  async createSession(): Promise<SessionInfo> {
    this.calls.push('create')
    return session(this.title)
  }

  async listRootSessions(): Promise<{
    sessions: GlobalSessionInfo[]
    nextCursorHeader: string | null
  }> {
    throw new Error('resume not expected')
  }

  async getLatestMessage(): Promise<WithParts[]> {
    this.calls.push('history')
    if (this.posted === undefined) return []
    const assistant = this.assistant(this.posted.messageID, true)
    return [{ info: assistant, parts: [this.answer(this.posted.messageID)] }]
  }

  async postMessageAsync(_sessionID: string, body: PromptRequest): Promise<void> {
    this.calls.push('post-async')
    this.posted = body
  }

  async postMessage(_sessionID: string, body: PromptRequest): Promise<WithParts> {
    this.calls.push('post-sync')
    this.posted = body
    const assistant = this.assistant(body.messageID, true)
    return { info: assistant, parts: [this.answer(body.messageID)] }
  }

  async abortSession(): Promise<boolean> {
    this.calls.push('abort')
    this.aborts += 1
    return true
  }

  async subscribeEvents(): Promise<AsyncGenerator<WireEvent>> {
    this.calls.push('subscribe')
    const posted = () => this.posted
    const assistant = (callerID: string, completed: boolean) => this.assistant(callerID, completed)
    const answer = (callerID: string) => this.answer(callerID)
    return (async function* () {
      yield wire('server.connected', {}, 1)
      const body = posted()
      if (body === undefined) throw new Error('POST must start before model events')
      const started = assistant(body.messageID, false)
      const completed = assistant(body.messageID, true)
      yield wire(
        'message.updated',
        {
          sessionID,
          info: {
            id: body.messageID,
            sessionID,
            role: 'user',
            time: { created: 100 },
            agent: 'worker',
            model,
          },
        },
        2,
      )
      yield wire(
        'message.part.updated',
        {
          sessionID,
          part: {
            id: id('prt', 100),
            sessionID,
            messageID: body.messageID,
            type: 'text',
            text: 'do the work',
          },
          time: 100,
        },
        3,
      )
      yield wire('message.updated', { sessionID, info: started }, 4)
      yield wire('message.part.updated', { sessionID, part: answer(body.messageID), time: 102 }, 5)
      yield wire('message.updated', { sessionID, info: completed }, 6)
      yield wire('session.status', { sessionID, status: { type: 'idle' } }, 7)
    })()
  }

  private assistant(callerID: string, completed: boolean) {
    return {
      id: id('msg', 102),
      sessionID,
      role: 'assistant' as const,
      time: { created: 102, ...(completed ? { completed: 200 } : {}) },
      parentID: callerID,
      modelID: 'gpt-5.6',
      providerID: 'openai',
      mode: 'worker',
      agent: 'worker',
      path: { cwd: worktreePath, root: worktreePath },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }
  }

  private answer(callerID: string) {
    void callerID
    return {
      id: id('prt', 102),
      sessionID,
      messageID: id('msg', 102),
      type: 'text' as const,
      text: 'done',
      time: { start: 1, end: 2 },
    }
  }
}

class HangingPromptClient extends FakeClient {
  override async postMessageAsync(
    _sessionID: string,
    body: PromptRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    this.calls.push('post-async')
    this.posted = body
    return new Promise((_, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted === true) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  override async postMessage(
    _sessionID: string,
    body: PromptRequest,
    signal?: AbortSignal,
  ): Promise<WithParts> {
    this.calls.push('post-sync')
    this.posted = body
    return new Promise((_, reject) => {
      const abort = () => reject(signal?.reason ?? new Error('aborted'))
      if (signal?.aborted === true) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  override async subscribeEvents(signal?: AbortSignal): Promise<AsyncGenerator<WireEvent>> {
    this.calls.push('subscribe')
    return (async function* () {
      yield wire('server.connected', {}, 1)
      await new Promise<void>((_, reject) => {
        const abort = () => reject(signal?.reason ?? new Error('aborted'))
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })()
  }
}

class MismatchedPromptClient extends FakeClient {
  override async getLatestMessage(): Promise<WithParts[]> {
    const response = await super.getLatestMessage()
    return response.map((message) => ({
      info: message.info,
      parts: message.parts.map((part) =>
        part.type === 'text' ? { ...part, text: `${part.text}-mismatch` } : part,
      ),
    }))
  }

  override async postMessage(sessionId: string, body: PromptRequest): Promise<WithParts> {
    const response = await super.postMessage(sessionId, body)
    return {
      info: response.info,
      parts: response.parts.map((part) =>
        part.type === 'text' ? { ...part, text: `${part.text}-mismatch` } : part,
      ),
    }
  }
}

class FakeResumeClient extends FakeClient {
  override async createSession(): Promise<SessionInfo> {
    throw new Error('resume must not create a replacement session')
  }

  override async listRootSessions(): Promise<{
    sessions: GlobalSessionInfo[]
    nextCursorHeader: null
  }> {
    this.calls.push('inventory')
    return {
      sessions: [{ ...session(this.title), project: null }],
      nextCursorHeader: null,
    }
  }
}

class InventoryClient extends FakeClient {
  override async getAgents(): Promise<unknown> {
    this.calls.push('agents')
    return [
      {
        name: 'build',
        mode: 'primary',
        native: true,
        permission: [],
        options: {},
      },
      {
        name: 'worker',
        mode: 'primary',
        native: false,
        permission: [],
        options: {},
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
      },
    ]
  }
}

function fakeServer(
  extraStdout = '',
  resistTerm = false,
  holdPipes = false,
): {
  process: VerifiedLauncherServerProcess
  signals: NodeJS.Signals[]
  closePipes(): void
} {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller
      controller.enqueue(
        new TextEncoder().encode(
          `opencode server listening on http://127.0.0.1:4096\n${extraStdout}`,
        ),
      )
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller
    },
  })
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  const signals: NodeJS.Signals[] = []
  let stopped = false
  let pipesClosed = false
  const closePipes = () => {
    if (pipesClosed) return
    pipesClosed = true
    stdoutController.close()
    stderrController.close()
  }
  return {
    signals,
    closePipes,
    process: {
      pid: 12345,
      stdout,
      stderr,
      exited,
      killGroup(signal) {
        signals.push(signal)
        if (stopped) return
        if (signal === 'SIGTERM' && resistTerm) return
        stopped = true
        if (!holdPipes) closePipes()
        resolveExit(0)
      },
      isGroupAlive: () => !stopped,
    },
  }
}

function dependencies(
  manifest: VerifiedLaunchManifest,
  client: FakeClient,
  overrides: Partial<VerifiedLauncherDependencies> = {},
) {
  const server = fakeServer()
  const scrubKinds: string[] = []
  const removed: string[] = []
  const lock: OpencodeStoreLifecycleLock = {
    dbPath: manifest.sessionDbPath,
    lockPath: join(STORE_ROOT, 'lock'),
    nonceDigest: 'c'.repeat(64),
    release: async () => undefined,
  }
  let clock = 100
  const deps: VerifiedLauncherDependencies = {
    verifySnapshot: async () => undefined,
    runFffProbe: async () => undefined,
    scanSource: async () => ({
      canonicalWorktree: worktreePath,
      digest: sourceDigest,
      directories: [],
    }),
    acquireStoreLock: async () => lock,
    bindStoreServer: async () => undefined,
    scrubStore: async (input) => {
      scrubKinds.push(input.kind)
      return { databasePresent: input.kind === 'existing' }
    },
    spawnServer: () => server.process,
    createClient: () => client,
    // RFC-251 removed the verifyIdentity seam along with the attestation step.
    verifyProviderInventory: () => undefined,
    verifySkillInventory: () => undefined,
    randomBytes: (size) => new Uint8Array(size),
    now: () => clock++,
    removeStore: async (path) => {
      removed.push(path)
    },
    ...overrides,
  }
  return { deps, server, scrubKinds, removed }
}

describe('RFC-224 verified launcher manifest split', () => {
  test('system is a closed new-only branch without business ownership secrets', () => {
    const manifest = systemManifest()
    expect(manifest.storeKind).toBe('system-ephemeral')
    expect(manifest).not.toHaveProperty('leaseNonce')
    expect(manifest).not.toHaveProperty('controlAckPath')
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        leaseNonce: 'secret',
      }),
    ).toThrow()
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        mode: 'resume',
      }),
    ).toThrow()
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        fffCapabilityCodec: 2,
      }),
    ).toThrow()
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        fffProbe: { ...manifest.fffProbe!, root: join(FIXTURE_ROOT, 'outside-run-root') },
      }),
    ).toThrow()
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        containmentAdmission: {
          ...manifest.containmentAdmission,
          capabilities: {
            ...manifest.containmentAdmission.capabilities,
            modelChildNetworkDeny: 'absent',
          },
        },
      }),
    ).toThrow()
    expect(() =>
      VerifiedLaunchManifestSchema.parse({
        ...manifest,
        containmentTopology: 'none',
      }),
    ).toThrow()
  })
})

describe('RFC-224 same-instance provider and skill gates', () => {
  test('accepts only a unique selected model backed by the bundled npm allowlist', () => {
    const inventory = {
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'env',
          env: ['OPENAI_API_KEY'],
          options: {},
          models: {
            'gpt-5.6': {
              id: 'gpt-5.6',
              providerID: 'openai',
              api: { id: 'gpt-5.6', url: 'https://api.openai.com', npm: '@ai-sdk/openai' },
              name: 'GPT',
              capabilities: {},
              cost: {},
              limit: {},
              status: 'active',
              options: {},
              headers: {},
              release_date: '',
            },
          },
        },
      ],
      default: { openai: 'gpt-5.6' },
    }
    expect(() => verifySelectedProviderInventory(inventory, model)).not.toThrow()
    const poisoned = structuredClone(inventory)
    poisoned.providers[0]!.models['gpt-5.6']!.api.npm = 'file:///tmp/secret-provider.ts'
    expect(() => verifySelectedProviderInventory(poisoned, model)).toThrow(
      'execution-identity-provider-untrusted',
    )
  })

  // 2026-07-28 — opencode 1.18.8 rewrote the built-in skill BODY while leaving
  // name/description/location byte-identical. A single frozen digest made every
  // verified run on that release fail closed (nightly `opencode latest` leg).
  // The boundary now accepts a REVIEWED allowlist: known bodies pass, an
  // unknown body still fails, and identity fields stay exact.
  test('skill body allowlist accepts every reviewed release and nothing else', () => {
    const oldBody = 'body as shipped by 1.18.3'
    const newBody = 'body as shipped by 1.18.8'
    const baseline = {
      name: 'customize-opencode',
      description: 'pinned',
      location: '<built-in>',
      contentDigests: [
        createHash('sha256').update(newBody).digest('hex'),
        createHash('sha256').update(oldBody).digest('hex'),
      ] as readonly string[],
    }
    const entry = (content: string) => [
      {
        name: baseline.name,
        description: baseline.description,
        location: baseline.location,
        content,
      },
    ]
    expect(() => verifyPinnedSkillInventory(entry(oldBody), baseline)).not.toThrow()
    expect(() => verifyPinnedSkillInventory(entry(newBody), baseline)).not.toThrow()
    expect(() => verifyPinnedSkillInventory(entry('an unreviewed body'), baseline)).toThrow(
      'execution-identity-skill-mismatch',
    )
    // Identity fields remain exact even when the body is allowlisted.
    expect(() =>
      verifyPinnedSkillInventory([{ ...entry(newBody)[0]!, name: 'sneaky-skill' }], baseline),
    ).toThrow('execution-identity-skill-mismatch')
    // And the production pin really does carry more than one reviewed body.
    expect(PINNED_BUILTIN_SKILL.contentDigests.length).toBeGreaterThanOrEqual(2)
  })

  test('skill inventory is exact and errors never include skill content', () => {
    const content = 'fixture built-in content'
    const baseline = {
      name: 'customize-opencode',
      description: 'pinned',
      location: '<built-in>',
      contentDigests: [createHash('sha256').update(content).digest('hex')] as readonly string[],
    }
    expect(() =>
      verifyPinnedSkillInventory([{ ...baseline, content, contentDigests: undefined }], baseline),
    ).toThrow()
    expect(() =>
      verifyPinnedSkillInventory(
        [
          {
            name: baseline.name,
            description: baseline.description,
            location: baseline.location,
            content,
          },
        ],
        baseline,
      ),
    ).not.toThrow()
    const secret = 'skill-secret-that-must-not-leak'
    try {
      verifyPinnedSkillInventory(
        [
          {
            name: baseline.name,
            description: baseline.description,
            location: baseline.location,
            content: secret,
          },
        ],
        baseline,
      )
      throw new Error('expected mismatch')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})

describe('RFC-224 launcher lifecycle and direct protocol ordering', () => {
  test('FFF proof runs before store acquisition and server spawn', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    let lockTouched = false
    let serverTouched = false
    const harness = dependencies(manifest, client, {
      runFffProbe: async () => {
        throw Object.assign(new Error('private probe detail'), {
          code: 'execution-identity-bootstrap-failed',
        })
      },
      acquireStoreLock: async () => {
        lockTouched = true
        throw new Error('unreachable')
      },
      spawnServer: () => {
        serverTouched = true
        throw new Error('unreachable')
      },
    })

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-bootstrap-failed',
    })
    expect(lockTouched).toBe(false)
    expect(serverTouched).toBe(false)
    expect(harness.scrubKinds).toEqual([])
  })

  test('system launch gates, creates, subscribes-before-POST, emits JSONL, and leaves capture store', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client)
    const stdout: string[] = []
    const stderr: string[] = []
    harness.deps.writeStdout = (value) => stdout.push(value)
    harness.deps.writeStderr = (value) => stderr.push(value)

    await launchVerifiedOpencodeManifest(manifest, harness.deps)

    // RFC-251: the attestation reads are gone — no /config fetch and no second
    // /agent. What remains is single-read fact gathering before session create.
    expect(client.calls).toEqual([
      'providers',
      'agents',
      'skills',
      'create',
      'subscribe',
      'history',
      'post-async',
      'history',
    ])
    expect(stdout.map((line) => JSON.parse(line).type)).toEqual(['text'])
    expect(stderr).toEqual([])
    expect(harness.scrubKinds).toEqual(['fresh', 'fresh'])
    expect(harness.removed).toEqual([])
    expect(harness.server.signals).toEqual(['SIGTERM'])
  })

  test('business emits a nonce-digest marker, waits for ok ack, and preserves success store', async () => {
    const manifest = businessManifest()
    if (manifest.storeKind !== 'business') throw new Error('fixture narrowing failed')
    const client = new FakeClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client, {
      readAck: async (_path, nonce) => ({ decision: 'ok', nonce }),
    })
    const stderr: string[] = []
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = (value) => stderr.push(value)

    await launchVerifiedOpencodeManifest(manifest, harness.deps)

    expect(stderr).toHaveLength(1)
    const parsed = parseControlLine(stderr[0]!.trimEnd())
    expect(parsed).toMatchObject({
      kind: 'session-ready',
      marker: {
        kind: 'new',
        sessionId: sessionID,
        projectId: 'project-1',
        nodeRunId: 'run-1',
        leaseNonceDigest: manifest.leaseNonceDigest,
      },
    })
    expect(stderr[0]).not.toContain(manifest.leaseNonce)
    expect(harness.removed).toEqual([])
  })

  test('MCP playground new and resume runs wait for exact control ACK before model access', async () => {
    for (const mode of ['new', 'resume'] as const) {
      const manifest = mcpTestManifest(mode)
      if (manifest.storeKind !== 'mcp-test') throw new Error('fixture narrowing failed')
      const client =
        mode === 'new'
          ? new FakeClient(manifest.sessionTitle)
          : new FakeResumeClient(manifest.sessionTitle)
      const ackCalls: Array<{ path: string; nonce: string; modelStarted: boolean }> = []
      const harness = dependencies(manifest, client, {
        readAck: async (path, nonce) => {
          ackCalls.push({
            path,
            nonce,
            modelStarted:
              client.calls.includes('subscribe') ||
              client.calls.includes('post-async') ||
              client.calls.includes('post-sync'),
          })
          return { decision: 'ok', nonce }
        },
      })
      const stderr: string[] = []
      harness.deps.writeStdout = () => undefined
      harness.deps.writeStderr = (value) => stderr.push(value)

      await launchVerifiedOpencodeManifest(manifest, harness.deps)

      expect(ackCalls).toEqual([
        {
          path: manifest.controlAckPath,
          nonce: manifest.leaseNonce,
          modelStarted: false,
        },
      ])
      const marker = parseControlLine(stderr[0]!.trimEnd())
      expect(marker).toMatchObject({
        kind: 'session-ready',
        marker: {
          kind: mode,
          sessionId: sessionID,
          projectId: 'project-1',
          nodeRunId: manifest.turnId,
          leaseNonceDigest: manifest.leaseNonceDigest,
        },
      })
      expect(stderr[0]).not.toContain(manifest.leaseNonce)
      expect(client.calls).toContain('subscribe')
      expect(client.calls).toContain('post-async')
      expect(client.calls.includes('create')).toBe(mode === 'new')
      expect(client.calls.includes('inventory')).toBe(mode === 'resume')
      expect(harness.scrubKinds).toEqual([
        mode === 'new' ? 'fresh' : 'existing',
        mode === 'new' ? 'fresh' : 'existing',
      ])
      expect(harness.server.signals).toEqual(['SIGTERM'])
    }
  })

  test('business inventory is written after the complete same-instance gate and before session creation', async () => {
    const manifest = VerifiedLaunchManifestSchema.parse({
      ...businessManifest(),
      inventory: {
        enabled: true,
        frozenSkills: [
          {
            name: 'review-code',
            skillId: 'skill-review',
            treeDigest: 'a'.repeat(64),
          },
        ],
        mcps: [{ name: 'docs', type: 'remote' }],
        plugins: [{ specifier: 'file:///tmp/aw-plugins/dd', source: 'npm' }],
      },
    })
    if (manifest.storeKind !== 'business') throw new Error('fixture narrowing failed')
    const client = new InventoryClient(manifest.sessionTitle)
    const writes: Array<{
      root: string
      snapshot: InventorySnapshotCaptured
      callsAtWrite: string[]
    }> = []
    const harness = dependencies(manifest, client, {
      readAck: async (_path, nonce) => ({ decision: 'ok', nonce }),
      writeInventory: async (root, snapshot) => {
        writes.push({ root, snapshot, callsAtWrite: [...client.calls] })
      },
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await launchVerifiedOpencodeManifest(manifest, harness.deps)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.root).toBe(manifest.runRoot)
    // RFC-251: inventory is derived from the single /agent read, and is still
    // written before session creation (asserted below).
    expect(writes[0]!.callsAtWrite).toEqual(['providers', 'agents', 'skills'])
    expect(writes[0]!.snapshot).toMatchObject({
      captured: true,
      // RFC-251 (Codex impl-gate P1): plugins are reported from the frozen
      // selection instead of the old structural `[]`, so a selected plugin no
      // longer renders as "Plugins·0" in run details.
      plugins: [{ specifier: 'file:///tmp/aw-plugins/dd', source: 'npm' }],
      mcps: [{ name: 'docs', type: 'remote', status: 'configured', hint: null }],
    })
    expect(client.calls.indexOf('create')).toBeGreaterThan(client.calls.lastIndexOf('agents'))
  })

  test('a failed same-instance skill gate never writes inventory', async () => {
    const manifest = VerifiedLaunchManifestSchema.parse({
      ...businessManifest(),
      inventory: { enabled: true, frozenSkills: [], mcps: [], plugins: [] },
    })
    if (manifest.storeKind !== 'business') throw new Error('fixture narrowing failed')
    const client = new InventoryClient(manifest.sessionTitle)
    let writes = 0
    const harness = dependencies(manifest, client, {
      verifySkillInventory: (value) => verifyPinnedSkillInventory(value),
      writeInventory: async () => {
        writes += 1
      },
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-skill-mismatch',
    })
    expect(writes).toBe(0)
    expect(client.calls).not.toContain('create')
  })

  test('resume uses the current-instance root inventory and exact frozen provenance', async () => {
    const manifest = resumeManifest()
    if (manifest.storeKind !== 'business') throw new Error('fixture narrowing failed')
    const client = new FakeResumeClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client, {
      readAck: async (_path, nonce) => ({ decision: 'ok', nonce }),
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await launchVerifiedOpencodeManifest(manifest, harness.deps)

    expect(client.calls).toContain('inventory')
    expect(client.calls).not.toContain('create')
    expect(harness.scrubKinds).toEqual(['existing', 'existing'])
    expect(harness.removed).toEqual([])
  })

  test('nack aborts before SSE/POST, fully reaps, and leaves the failed store for parent capture', async () => {
    const manifest = businessManifest()
    if (manifest.storeKind !== 'business') throw new Error('fixture narrowing failed')
    const client = new FakeClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client, {
      readAck: async (_path, nonce) => ({ decision: 'nack', nonce }),
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-control-failed',
    })
    expect(client.calls).not.toContain('subscribe')
    expect(client.calls).not.toContain('post-async')
    expect(client.calls).not.toContain('post-sync')
    expect(client.aborts).toBe(1)
    expect(harness.server.signals).toEqual(['SIGTERM'])
    expect(harness.removed).toEqual([])
  })

  test('extra server stdout is bootstrap drift and still performs full cleanup', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const server = fakeServer('unexpected second line\n')
    const harness = dependencies(manifest, client, {
      spawnServer: () => server.process,
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined
    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-bootstrap-failed',
    })
    expect(server.signals).toEqual(['SIGTERM'])
    expect(harness.removed).toEqual([])
  })

  test('run timeout aborts SSE/POST, aborts the session, reaps, and leaves capture store', async () => {
    const manifest = VerifiedLaunchManifestSchema.parse({
      ...systemManifest(),
      runTimeoutMs: 10,
    })
    const client = new HangingPromptClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client)
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-timeout',
    })
    expect(client.calls).toContain('post-async')
    expect(client.calls).not.toContain('post-sync')
    expect(client.calls).toContain('abort')
    expect(harness.server.signals).toEqual(['SIGTERM'])
    expect(harness.scrubKinds).toEqual(['fresh', 'fresh'])
    expect(harness.removed).toEqual([])
  })

  test('stream failures retain the closed codec reason before store cleanup', async () => {
    const manifest = systemManifest()
    const client = new MismatchedPromptClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client)
    const stderr: string[] = []
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = (value) => stderr.push(value)

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-stream-failed',
    })
    expect(stderr).toContain('AW_OPENCODE_CODEC_FAILURE response-mismatch\n')
  })

  test('TERM-resistant server is escalated through its negative-pid process group', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const server = fakeServer('', true)
    const harness = dependencies(manifest, client, {
      spawnServer: () => server.process,
      serverStopGraceMs: 5,
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await launchVerifiedOpencodeManifest(manifest, harness.deps)

    expect(server.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.scrubKinds).toEqual(['fresh', 'fresh'])
    expect(harness.removed).toEqual([])
  })

  test('an unreaped server retains its lifecycle lock and store for boot recovery', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const server = fakeServer('', true, true)
    const neverExited = new Promise<number>(() => {})
    const signals: NodeJS.Signals[] = []
    let releases = 0
    const harness = dependencies(manifest, client, {
      spawnServer: () => ({
        ...server.process,
        exited: neverExited,
        killGroup: (signal) => {
          signals.push(signal)
        },
      }),
      acquireStoreLock: async () => ({
        dbPath: manifest.sessionDbPath,
        lockPath: join(STORE_ROOT, 'lock'),
        nonceDigest: 'c'.repeat(64),
        release: async () => {
          releases += 1
        },
      }),
      serverStopGraceMs: 5,
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    try {
      await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
        code: 'execution-identity-store-unsafe',
      })
    } finally {
      server.closePipes()
    }
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(harness.scrubKinds).toEqual(['fresh'])
    expect(releases).toBe(0)
    expect(harness.removed).toEqual([])
  })

  test('pipe drain is bounded even when an escaped writer keeps descriptors open', async () => {
    const manifest = systemManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const server = fakeServer('', false, true)
    const harness = dependencies(manifest, client, {
      spawnServer: () => server.process,
      serverStopGraceMs: 5,
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    try {
      await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
        code: 'execution-identity-store-unsafe',
      })
    } finally {
      server.closePipes()
    }
    expect(server.signals).toEqual(['SIGTERM'])
    expect(harness.scrubKinds).toEqual(['fresh', 'fresh'])
  })

  test('a lock acquisition loser never deletes a store it did not own', async () => {
    const manifest = businessManifest()
    const client = new FakeClient(manifest.sessionTitle)
    const harness = dependencies(manifest, client, {
      acquireStoreLock: async () => {
        throw Object.assign(new Error('contended'), {
          code: 'execution-identity-store-unsafe',
        })
      },
    })
    harness.deps.writeStdout = () => undefined
    harness.deps.writeStderr = () => undefined

    await expect(launchVerifiedOpencodeManifest(manifest, harness.deps)).rejects.toMatchObject({
      code: 'execution-identity-store-unsafe',
    })
    expect(harness.removed).toEqual([])
    expect(harness.scrubKinds).toEqual([])
  })
})

describe('RFC-224 hidden launcher failure channel', () => {
  test('unsafe one-shot manifest is unlinked and only a stable code reaches stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc224-launcher-'))
    roots.push(root)
    const manifestPath = join(root, 'manifest.json')
    const secret = 'manifest-secret-never-print'
    await writeFile(manifestPath, JSON.stringify({ secret }), { mode: 0o644 })
    await chmod(manifestPath, 0o644)
    const stderr: string[] = []

    const code = await runVerifiedOpencodeLauncher(manifestPath, {
      writeStderr: (value) => stderr.push(value),
    })

    expect(code).toBe(1)
    expect(stderr).toEqual(['AW_OPENCODE_FAILURE execution-identity-store-unsafe\n'])
    expect(stderr.join('')).not.toContain(secret)
    await expect(lstat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('hidden commands stay out of help and invalid argv emits only the stable channel', async () => {
    const mainPath = resolve(import.meta.dir, '../src/main.ts')
    const help = Bun.spawn({
      cmd: [process.execPath, 'run', mainPath, 'help'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const helpOutput = await new Response(help.stdout).text()
    expect(await help.exited).toBe(0)
    expect(helpOutput).not.toContain('__opencode-verified-run')
    expect(helpOutput).not.toContain('__opencode-netless-subprocess')
    expect(helpOutput).not.toContain('__opencode-bwrap-capability-supervisor')

    for (const subcommand of [
      '__opencode-verified-run',
      '__opencode-bwrap-capability-supervisor',
    ]) {
      const invalid = Bun.spawn({
        cmd: [process.execPath, 'run', mainPath, subcommand],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await invalid.exited).toBe(1)
      expect(await new Response(invalid.stdout).text()).toBe('')
      expect(await new Response(invalid.stderr).text()).toBe(
        'AW_OPENCODE_FAILURE execution-identity-store-unsafe\n',
      )
    }
  })
})
