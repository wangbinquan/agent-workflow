// RFC-224 — hidden, fail-closed OpenCode direct-API launcher.
//
// This process is the only production caller of `opencode serve`. It consumes
// one private manifest, re-attests every frozen identity input, owns the
// loopback server and SSE stream, and writes only the pinned `run --format
// json` records to stdout. All diagnostic failures use the closed stable-code
// channel; host paths, HTTP bodies, config values and credentials are never
// interpolated into stderr.

import { createHash, randomBytes } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ExecutionIdentityFailureCode } from '@agent-workflow/shared'
import {
  AscendingMessageIdGenerator,
  PINNED_OPENCODE_VERSION,
  SessionInventoryAccumulator,
  assertMessageIdAfterHistory,
  buildCreateSessionRequest,
  buildPromptRequest,
  decodeAscendingMessageId,
  validateLatestMessageInventory,
  validateSessionIdentity,
  type CreateSessionRequest,
  type GlobalSessionInfo,
  type PromptRequest,
  type SelectedModel,
  type SessionInfo,
  type WireEvent,
  type WithParts,
} from './directApiSchemas'
import { OpencodeDirectClient, type DirectClientBudgets } from './directClient'
import { DirectSessionCodec, serializeDirectJsonlRecord, type DirectCodecStep } from './directCodec'
import {
  businessOpencodeIdentityDigest,
  ExecutionIdentityError,
  identityDigest,
  verifyExecutionIdentity,
} from './executionIdentity'
import { ExecutionIdentityFailure, executionIdentityFailure } from './failure'
import {
  PINNED_BUILTIN_SKILL,
  assertBundledProviderImplementation,
  removeHermeticOpencodeLayout,
} from './hermetic'
import { OfficialOpencodeBinaryError, verifyOfficialSnapshot } from './officialBuilds'
import {
  assertSourceFingerprintUnchanged,
  scanOpencodeProjectSurface,
  type OpencodeSourceFingerprint,
} from './sourceGuard'
import {
  acquireOpencodeStoreLifecycleLock,
  bindOpencodeStoreServerProcess,
  scrubOpencodeStoreAccountState,
  type OpencodeStoreLifecycleLock,
  type OpencodeStoreServerBinding,
} from './storeHygiene'
import { buildSessionReadyMarker, readControlAck, type ControlAck } from './controlProtocol'
import {
  readAndUnlinkVerifiedLaunchManifest,
  type VerifiedLaunchManifest,
} from './verifiedManifest'
import { runFffCapabilityProbe } from './fffCapability'
import { buildVerifiedInventorySnapshot, writeVerifiedInventorySnapshot } from './verifiedInventory'

const LISTEN_LINE_RE = /^opencode server listening on http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/
const MAX_SERVER_STDOUT_LINE_BYTES = 1024
const MAX_SERVER_STDERR_TAIL_BYTES = 64 * 1024
const SERVER_STOP_GRACE_MS = 2_000
const ACK_POLL_MS = 20
const ACK_TIMEOUT_MS = 10_000
const ABORT_REQUEST_TIMEOUT_MS = 1_000

export interface VerifiedLauncherServerProcess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  /** Signal the dedicated server process group (`kill(-pid, signal)`). */
  killGroup(signal: NodeJS.Signals): void
  /** Host call made inside the private PID namespace; true includes descendants. */
  isGroupAlive(): boolean
}

export interface VerifiedLauncherClient {
  getConfig(signal?: AbortSignal): Promise<unknown>
  getConfigProviders(signal?: AbortSignal): Promise<unknown>
  getAgents(signal?: AbortSignal): Promise<unknown>
  getSkills(signal?: AbortSignal): Promise<unknown>
  createSession(body: CreateSessionRequest, signal?: AbortSignal): Promise<SessionInfo>
  listRootSessions(input: {
    title: string
    cursor?: number
    signal?: AbortSignal
  }): Promise<{ sessions: GlobalSessionInfo[]; nextCursorHeader: string | null }>
  getLatestMessage(sessionID: string, signal?: AbortSignal): Promise<WithParts[]>
  postMessage(sessionID: string, body: PromptRequest, signal?: AbortSignal): Promise<WithParts>
  abortSession(sessionID: string, signal?: AbortSignal): Promise<boolean>
  subscribeEvents(signal?: AbortSignal): Promise<AsyncGenerator<WireEvent>>
}

export interface SpawnVerifiedServerInput {
  command: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}

export interface VerifiedLauncherDependencies {
  signal?: AbortSignal
  readManifest?: (path: string) => Promise<VerifiedLaunchManifest>
  verifySnapshot?: (path: string, digest: string) => Promise<void>
  runFffProbe?: typeof runFffCapabilityProbe
  scanSource?: (worktreePath: string) => Promise<OpencodeSourceFingerprint>
  acquireStoreLock?: (dbPath: string, nonce?: string) => Promise<OpencodeStoreLifecycleLock>
  bindStoreServer?: (
    lock: OpencodeStoreLifecycleLock,
    binding: OpencodeStoreServerBinding,
  ) => Promise<void>
  scrubStore?: typeof scrubOpencodeStoreAccountState
  spawnServer?: (input: SpawnVerifiedServerInput) => VerifiedLauncherServerProcess
  createClient?: (input: {
    origin: string
    directory: string
    username: string
    password: string
    budgets: Partial<DirectClientBudgets>
  }) => VerifiedLauncherClient
  verifyIdentity?: typeof verifyExecutionIdentity
  verifyProviderInventory?: typeof verifySelectedProviderInventory
  verifySkillInventory?: typeof verifyPinnedSkillInventory
  writeInventory?: typeof writeVerifiedInventorySnapshot
  randomBytes?: (size: number) => Uint8Array
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readAck?: (path: string, expectedNonce: string) => Promise<ControlAck | null>
  removeStore?: (path: string) => Promise<void>
  serverStopGraceMs?: number
  writeStdout?: (value: string) => void
  writeStderr?: (value: string) => void
}

class LauncherCancelledError extends Error {
  constructor() {
    super('launcher-cancelled')
    this.name = 'LauncherCancelledError'
  }
}

class LauncherPhaseError extends Error {
  readonly code: ExecutionIdentityFailureCode

  constructor(code: ExecutionIdentityFailureCode) {
    super(code)
    this.name = 'LauncherPhaseError'
    this.code = code
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function phaseFailure(code: ExecutionIdentityFailureCode): never {
  throw new LauncherPhaseError(code)
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return Promise.reject(new TypeError('invalid sleep duration'))
  }
  if (signal?.aborted === true) return Promise.reject(new LauncherCancelledError())
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new LauncherCancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => {
      if (signal?.aborted === true) abort()
    })
  })
}

function defaultSpawnServer(input: SpawnVerifiedServerInput): VerifiedLauncherServerProcess {
  try {
    const child = Bun.spawn({
      cmd: [...input.command],
      cwd: input.cwd,
      env: { ...input.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // The launcher owns this dedicated group and always reaps it before
      // releasing the store lock. This also reaches provider/bootstrap
      // descendants if the server does not shut them down itself.
      detached: true,
    })
    return {
      pid: child.pid,
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: child.stderr as ReadableStream<Uint8Array>,
      exited: child.exited,
      killGroup: (signal) => {
        try {
          process.kill(-child.pid, signal)
        } catch {
          // A concurrent clean exit may remove the group between the exited
          // check and signal. `child.kill` is a best-effort final nudge and
          // does not turn ESRCH into a host-path-bearing diagnostic.
          child.kill(signal)
        }
      },
      isGroupAlive: () => {
        try {
          process.kill(-child.pid, 0)
          return true
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM'
        }
      },
    }
  } catch {
    return phaseFailure('execution-identity-bootstrap-failed')
  }
}

function defaultCreateClient(input: {
  origin: string
  directory: string
  username: string
  password: string
  budgets: Partial<DirectClientBudgets>
}): VerifiedLauncherClient {
  return new OpencodeDirectClient(input)
}

async function defaultReadAck(path: string, expectedNonce: string): Promise<ControlAck | null> {
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return phaseFailure('execution-identity-control-failed')
  }
  try {
    return readControlAck(path, expectedNonce)
  } catch {
    return phaseFailure('execution-identity-control-failed')
  }
}

async function defaultRemoveStore(path: string): Promise<void> {
  await removeHermeticOpencodeLayout(path)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}

function safeMismatch(code: ExecutionIdentityFailureCode = 'execution-identity-mismatch'): never {
  return executionIdentityFailure(code)
}

/**
 * Validate the exact v1.18.3 `/config/providers` shape needed to prove that
 * the selected model resolves to a bundled implementation. The endpoint is
 * already bounded to finite plain JSON by DirectClient; this closes its
 * identity-bearing outer/provider/model fields without logging any value.
 */
export function verifySelectedProviderInventory(value: unknown, selected: SelectedModel): void {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, ['providers', 'default']) ||
    !Array.isArray(value.providers) ||
    !isPlainRecord(value.default) ||
    Object.values(value.default).some((entry) => typeof entry !== 'string')
  ) {
    return safeMismatch()
  }
  const providers = value.providers
  const providerIds = new Set<string>()
  let selectedProvider: Record<string, unknown> | undefined
  for (const candidate of providers) {
    if (
      !isPlainRecord(candidate) ||
      !exactKeys(candidate, ['id', 'name', 'source', 'env', 'options', 'models'], ['key']) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      typeof candidate.name !== 'string' ||
      !['env', 'config', 'custom', 'api'].includes(String(candidate.source)) ||
      !Array.isArray(candidate.env) ||
      candidate.env.some((entry) => typeof entry !== 'string') ||
      !isPlainRecord(candidate.options) ||
      !isPlainRecord(candidate.models) ||
      (candidate.key !== undefined && typeof candidate.key !== 'string') ||
      providerIds.has(candidate.id)
    ) {
      return safeMismatch()
    }
    providerIds.add(candidate.id)
    if (candidate.id === selected.providerID) selectedProvider = candidate
  }
  if (selectedProvider === undefined) {
    return executionIdentityFailure('execution-identity-provider-untrusted')
  }
  const models = selectedProvider.models as Record<string, unknown>
  const model = models[selected.modelID]
  if (
    !isPlainRecord(model) ||
    !exactKeys(
      model,
      [
        'id',
        'providerID',
        'api',
        'name',
        'capabilities',
        'cost',
        'limit',
        'status',
        'options',
        'headers',
        'release_date',
      ],
      ['family', 'variants'],
    ) ||
    model.id !== selected.modelID ||
    model.providerID !== selected.providerID ||
    !isPlainRecord(model.api) ||
    !exactKeys(model.api, ['id', 'url', 'npm']) ||
    typeof model.api.id !== 'string' ||
    typeof model.api.url !== 'string' ||
    typeof model.api.npm !== 'string'
  ) {
    return executionIdentityFailure('execution-identity-provider-untrusted')
  }
  assertBundledProviderImplementation(model.api.npm)
  if (
    selected.variant !== undefined &&
    (!isPlainRecord(model.variants) || !Object.hasOwn(model.variants, selected.variant))
  ) {
    return executionIdentityFailure('execution-identity-provider-untrusted')
  }
}

/** Exact pinned built-in baseline; disk/project/platform skills are forbidden. */
export function verifyPinnedSkillInventory(
  value: unknown,
  baseline: {
    name: string
    description: string
    location: string
    contentDigest: string
  } = PINNED_BUILTIN_SKILL,
): void {
  if (!Array.isArray(value) || value.length !== 1) {
    return executionIdentityFailure('execution-identity-skill-mismatch')
  }
  const skill = value[0]
  if (
    !isPlainRecord(skill) ||
    !exactKeys(skill, ['name', 'description', 'location', 'content']) ||
    skill.name !== baseline.name ||
    skill.description !== baseline.description ||
    skill.location !== baseline.location ||
    typeof skill.content !== 'string' ||
    sha256(skill.content) !== baseline.contentDigest
  ) {
    return executionIdentityFailure('execution-identity-skill-mismatch')
  }
}

function expectedSessionContract(manifest: VerifiedLaunchManifest): unknown {
  return {
    directory: manifest.worktreePath,
    path: '',
    title: manifest.sessionTitle,
    agent: manifest.selectedAgent,
    model: manifest.selectedModel,
    permission: [
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
    ],
    parentID: null,
    workspaceID: null,
    share: null,
    revert: null,
    metadata: null,
    version: PINNED_OPENCODE_VERSION,
  }
}

function verifyManifestDigests(manifest: VerifiedLaunchManifest): void {
  const expectedIdentity =
    manifest.storeKind === 'business'
      ? businessOpencodeIdentityDigest({
          config: manifest.expectedConfig,
          agent: manifest.selectedAgent,
          model: manifest.selectedModel,
          officialBuildDigest: manifest.officialBuildDigest,
          sealRoot: join(manifest.runRoot, 'opencode-identity-seal'),
        })
      : identityDigest({
          codec: 1,
          config: manifest.expectedConfig,
          agent: manifest.selectedAgent,
          model: manifest.selectedModel,
          officialBuildDigest: manifest.officialBuildDigest,
        })
  if (
    expectedIdentity !== manifest.identityDigest ||
    identityDigest(expectedSessionContract(manifest)) !== manifest.sessionContractDigest
  ) {
    return executionIdentityFailure('execution-identity-mismatch')
  }
  if (
    manifest.storeKind === 'business' &&
    sha256(manifest.leaseNonce) !== manifest.leaseNonceDigest
  ) {
    return executionIdentityFailure('execution-identity-control-failed')
  }
}

function resolveStoreRoot(manifest: VerifiedLaunchManifest): string {
  const xdgData = manifest.serverEnv.XDG_DATA_HOME
  if (
    typeof xdgData !== 'string' ||
    !isAbsolute(xdgData) ||
    resolve(xdgData) !== xdgData ||
    join(xdgData, 'opencode', 'opencode.db') !== manifest.sessionDbPath
  ) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const storeRoot = dirname(xdgData)
  if (storeRoot === dirname(storeRoot) || !manifest.sessionDbPath.startsWith(`${storeRoot}/`)) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  return storeRoot
}

function serverCredentials(manifest: VerifiedLaunchManifest): {
  username: string
  password: string
} {
  const username = manifest.serverEnv.OPENCODE_SERVER_USERNAME
  const password = manifest.serverEnv.OPENCODE_SERVER_PASSWORD
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username.length === 0 ||
    password.length === 0 ||
    username.includes(':') ||
    /[\0\r\n]/.test(username) ||
    /[\0\r\n]/.test(password) ||
    manifest.serverEnv.PWD !== manifest.worktreePath
  ) {
    return executionIdentityFailure('execution-identity-auth-invalid')
  }
  return { username, password }
}

async function* boundedUtf8Lines(
  stream: ReadableStream<Uint8Array>,
  maxLineBytes: number,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffered = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value === undefined) return phaseFailure('execution-identity-bootstrap-failed')
      try {
        buffered += decoder.decode(next.value, { stream: true })
      } catch {
        return phaseFailure('execution-identity-bootstrap-failed')
      }
      if (Buffer.byteLength(buffered, 'utf8') > maxLineBytes * 2) {
        return phaseFailure('execution-identity-bootstrap-failed')
      }
      for (;;) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) break
        let line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          return phaseFailure('execution-identity-bootstrap-failed')
        }
        yield line
      }
      if (Buffer.byteLength(buffered, 'utf8') > maxLineBytes) {
        return phaseFailure('execution-identity-bootstrap-failed')
      }
    }
    try {
      buffered += decoder.decode()
    } catch {
      return phaseFailure('execution-identity-bootstrap-failed')
    }
    if (buffered !== '') {
      return phaseFailure('execution-identity-bootstrap-failed')
    }
  } finally {
    reader.releaseLock()
  }
}

interface StdoutMonitor {
  ready: Promise<number>
  violation: Promise<never>
  done: Promise<void>
}

function monitorServerStdout(stream: ReadableStream<Uint8Array>): StdoutMonitor {
  const ready = deferred<number>()
  const violation = deferred<never>()
  let sawListen = false
  const done = (async () => {
    try {
      for await (const line of boundedUtf8Lines(stream, MAX_SERVER_STDOUT_LINE_BYTES)) {
        if (sawListen) return phaseFailure('execution-identity-bootstrap-failed')
        const match = LISTEN_LINE_RE.exec(line)
        if (match === null) return phaseFailure('execution-identity-bootstrap-failed')
        const port = Number(match[1])
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          return phaseFailure('execution-identity-bootstrap-failed')
        }
        sawListen = true
        ready.resolve(port)
      }
      if (!sawListen) return phaseFailure('execution-identity-bootstrap-failed')
    } catch (error) {
      ready.reject(error)
      violation.reject(error)
      throw error
    }
  })()
  // Observe the pump rejection even if readiness won a race earlier.
  void done.catch(() => {})
  return { ready: ready.promise, violation: violation.promise, done }
}

async function drainServerStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  let retained = Buffer.alloc(0)
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value === undefined) continue
      retained = Buffer.concat([retained, Buffer.from(next.value)])
      if (retained.byteLength > MAX_SERVER_STDERR_TAIL_BYTES) {
        retained = retained.subarray(retained.byteLength - MAX_SERVER_STDERR_TAIL_BYTES)
      }
    }
  } finally {
    retained.fill(0)
    reader.releaseLock()
  }
}

async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  code: ExecutionIdentityFailureCode,
  parentSignal: AbortSignal | undefined,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
): Promise<T> {
  if (parentSignal?.aborted === true) throw new LauncherCancelledError()
  const controller = new AbortController()
  const cancel = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', cancel, { once: true })
  try {
    return await Promise.race([
      operation(controller.signal),
      sleep(milliseconds, parentSignal).then(() => {
        controller.abort(new LauncherPhaseError(code))
        return phaseFailure(code)
      }),
    ])
  } finally {
    parentSignal?.removeEventListener('abort', cancel)
    controller.abort(new Error('launcher-phase-complete'))
  }
}

async function guardedByServer<T>(
  operation: Promise<T>,
  child: VerifiedLauncherServerProcess,
  stdoutViolation: Promise<never>,
): Promise<T> {
  return Promise.race([
    operation,
    stdoutViolation,
    child.exited.then(() => phaseFailure('execution-identity-bootstrap-failed')),
  ])
}

async function waitForControlAck(
  manifest: Extract<VerifiedLaunchManifest, { storeKind: 'business' }>,
  input: {
    signal?: AbortSignal
    now: () => number
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
    readAck: (path: string, expectedNonce: string) => Promise<ControlAck | null>
  },
): Promise<void> {
  const deadline = input.now() + Math.min(ACK_TIMEOUT_MS, manifest.bootstrapTimeoutMs)
  for (;;) {
    if (input.signal?.aborted === true) throw new LauncherCancelledError()
    const ack = await input.readAck(manifest.controlAckPath, manifest.leaseNonce)
    if (ack !== null) {
      await unlink(manifest.controlAckPath).catch(() => {})
      if (ack.decision !== 'ok') {
        return executionIdentityFailure('execution-identity-control-failed')
      }
      return
    }
    if (input.now() >= deadline) {
      return executionIdentityFailure('execution-identity-control-failed')
    }
    await input.sleep(ACK_POLL_MS, input.signal)
  }
}

function sessionExpectation(
  manifest: VerifiedLaunchManifest,
  extra: { sessionID?: string; projectID?: string } = {},
) {
  return {
    ...extra,
    directory: manifest.worktreePath,
    path: '',
    title: manifest.sessionTitle,
    agent: manifest.selectedAgent,
    model: manifest.selectedModel,
    version: PINNED_OPENCODE_VERSION,
  }
}

async function resolveSession(
  manifest: VerifiedLaunchManifest,
  client: VerifiedLauncherClient,
  signal?: AbortSignal,
): Promise<SessionInfo | GlobalSessionInfo> {
  if (manifest.mode === 'new') {
    const created = await client.createSession(
      buildCreateSessionRequest({
        title: manifest.sessionTitle,
        agent: manifest.selectedAgent,
        model: manifest.selectedModel,
      }),
      signal,
    )
    return validateSessionIdentity(created, sessionExpectation(manifest), 'create-response')
  }

  const expectedSessionId = manifest.expectedSessionId
  const expectedProjectId = manifest.expectedProjectId
  if (expectedSessionId === undefined || expectedProjectId === undefined) {
    return executionIdentityFailure('execution-identity-session-mismatch')
  }
  const accumulator = new SessionInventoryAccumulator()
  let cursor: number | undefined
  for (;;) {
    const page = await client.listRootSessions({
      title: manifest.sessionTitle,
      ...(cursor === undefined ? {} : { cursor }),
      signal,
    })
    const added = accumulator.addPage(page.sessions, page.nextCursorHeader, cursor)
    if (added.nextCursor === null) break
    cursor = added.nextCursor
  }
  return accumulator.finish(
    sessionExpectation(manifest, {
      sessionID: expectedSessionId,
      projectID: expectedProjectId,
    }) as ReturnType<typeof sessionExpectation> & { sessionID: string },
  )
}

async function waitForClockAfter(
  threshold: number,
  input: {
    signal?: AbortSignal
    now: () => number
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  },
): Promise<number> {
  for (;;) {
    if (input.signal?.aborted === true) throw new LauncherCancelledError()
    const current = input.now()
    if (!Number.isSafeInteger(current) || current < 0) {
      return executionIdentityFailure('execution-identity-stream-failed')
    }
    if (current > threshold) return current
    await input.sleep(Math.min(Math.max(threshold - current + 1, 1), 50), input.signal)
  }
}

function stepOrFail(step: DirectCodecStep, writeStdout: (value: string) => void): boolean {
  for (const record of step.records) writeStdout(serializeDirectJsonlRecord(record))
  if (step.state === 'failed') {
    return executionIdentityFailure('execution-identity-stream-failed')
  }
  return step.state === 'success'
}

async function runPromptStream(input: {
  manifest: VerifiedLaunchManifest
  client: VerifiedLauncherClient
  sessionID: string
  signal?: AbortSignal
  random: (size: number) => Uint8Array
  now: () => number
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  writeStdout: (value: string) => void
}): Promise<void> {
  const eventController = new AbortController()
  const abortFromParent = () => eventController.abort(input.signal?.reason)
  if (input.signal?.aborted === true) abortFromParent()
  else input.signal?.addEventListener('abort', abortFromParent, { once: true })

  let iterator: AsyncGenerator<WireEvent> | undefined
  try {
    iterator = await input.client.subscribeEvents(eventController.signal)
    const first = await iterator.next()
    if (first.done || first.value === undefined) {
      return executionIdentityFailure('execution-identity-stream-failed')
    }

    const history = validateLatestMessageInventory(
      await input.client.getLatestMessage(input.sessionID, eventController.signal),
      input.sessionID,
    )
    const latestID = history?.info.id
    const latestTimestamp =
      latestID === undefined ? -1 : decodeAscendingMessageId(latestID).timestampMs
    const callerTimestamp = await waitForClockAfter(latestTimestamp, {
      signal: eventController.signal,
      now: input.now,
      sleep: input.sleep,
    })
    const generator = new AscendingMessageIdGenerator(input.random)
    const callerMessageID = generator.create(callerTimestamp)
    assertMessageIdAfterHistory(callerMessageID, latestID === undefined ? [] : [latestID])

    const codec = new DirectSessionCodec({
      sessionID: input.sessionID,
      callerMessageID,
      agent: input.manifest.selectedAgent,
      model: input.manifest.selectedModel,
      prompt: input.manifest.prompt,
      path: { cwd: input.manifest.worktreePath, root: input.manifest.worktreePath },
      now: input.now,
    })
    const ready = codec.consume(first.value)
    if (ready.state !== 'ready') {
      return executionIdentityFailure('execution-identity-stream-failed')
    }

    await waitForClockAfter(callerTimestamp, {
      signal: eventController.signal,
      now: input.now,
      sleep: input.sleep,
    })
    if (stepOrFail(codec.markPromptPosted(), input.writeStdout)) return

    let settled = false
    const completion = deferred<void>()
    const acceptStep = (step: DirectCodecStep) => {
      if (settled) return
      try {
        if (stepOrFail(step, input.writeStdout)) {
          settled = true
          completion.resolve()
        }
      } catch (error) {
        settled = true
        completion.reject(error)
      }
    }

    const promptTask = input.client
      .postMessage(
        input.sessionID,
        buildPromptRequest({
          messageID: callerMessageID,
          agent: input.manifest.selectedAgent,
          model: input.manifest.selectedModel,
          prompt: input.manifest.prompt,
        }),
        eventController.signal,
      )
      .then((response) => acceptStep(codec.acceptPromptResponse(response)))
      .catch((error) => {
        if (!settled) {
          settled = true
          completion.reject(error)
        }
      })

    const eventTask = (async () => {
      try {
        for (;;) {
          const next = await iterator!.next()
          if (settled) return
          if (next.done || next.value === undefined) {
            acceptStep(codec.streamEnded())
            return
          }
          acceptStep(codec.consume(next.value))
        }
      } catch (error) {
        if (!settled) {
          settled = true
          completion.reject(error)
        }
      }
    })()

    await completion.promise
    eventController.abort(new Error('direct-stream-complete'))
    await Promise.allSettled([promptTask, eventTask])
  } catch (error) {
    if (error instanceof ExecutionIdentityFailure) throw error
    if (eventController.signal.aborted && input.signal?.aborted === true) {
      throw new LauncherCancelledError()
    }
    return executionIdentityFailure('execution-identity-stream-failed')
  } finally {
    input.signal?.removeEventListener('abort', abortFromParent)
    eventController.abort(new Error('direct-stream-finalize'))
    await iterator?.return(undefined).catch(() => undefined)
  }
}

async function bestEffortAbort(
  client: VerifiedLauncherClient | undefined,
  sessionID: string | undefined,
): Promise<void> {
  if (client === undefined || sessionID === undefined) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ABORT_REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    await client.abortSession(sessionID, controller.signal).catch(() => false)
  } finally {
    clearTimeout(timer)
  }
}

async function stopServer(
  child: VerifiedLauncherServerProcess,
  graceMs = SERVER_STOP_GRACE_MS,
): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0 || graceMs > 30_000) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  child.killGroup('SIGTERM')
  const waitStopped = async (): Promise<boolean> => {
    const deadline = Date.now() + graceMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      const settlement = await settleWithin(child.exited, Math.min(remaining, 25))
      if (settlement.status === 'rejected') return false
      if (settlement.status === 'fulfilled' && !child.isGroupAlive()) return true
      if (settlement.status === 'fulfilled') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(remaining, 25))
          timer.unref?.()
        })
      }
    }
  }
  if (await waitStopped()) return
  child.killGroup('SIGKILL')
  if (!(await waitStopped())) {
    // Never hand a potentially live SQLite writer back to scrub/release/delete.
    // The bound O_EXCL lock is intentionally retained for boot recovery.
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
}

type BoundedSettlement =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' }

async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<BoundedSettlement> {
  const observed: Promise<BoundedSettlement> = promise.then(
    () => ({ status: 'fulfilled' }) as const,
    (error: unknown) => ({ status: 'rejected', error }) as const,
  )
  return Promise.race([
    observed,
    new Promise<BoundedSettlement>((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout' }), milliseconds)
      timer.unref?.()
    }),
  ])
}

function stableFailureCode(error: unknown): ExecutionIdentityFailureCode {
  if (error instanceof ExecutionIdentityFailure) return error.code
  if (error instanceof ExecutionIdentityError) return error.code
  if (error instanceof OfficialOpencodeBinaryError) return error.code
  if (error instanceof LauncherPhaseError) return error.code
  return 'execution-identity-mismatch'
}

/**
 * Launch one already-parsed manifest. This function throws only closed
 * identity errors (or the private cancellation sentinel) and is dependency
 * injected so protocol/lifecycle tests never need a real provider or network.
 */
export async function launchVerifiedOpencodeManifest(
  manifest: VerifiedLaunchManifest,
  dependencies: VerifiedLauncherDependencies = {},
): Promise<void> {
  const verifySnapshot = dependencies.verifySnapshot ?? verifyOfficialSnapshot
  const runFffProbe = dependencies.runFffProbe ?? runFffCapabilityProbe
  const scanSource = dependencies.scanSource ?? scanOpencodeProjectSurface
  const acquireStoreLock = dependencies.acquireStoreLock ?? acquireOpencodeStoreLifecycleLock
  const bindStoreServer = dependencies.bindStoreServer ?? bindOpencodeStoreServerProcess
  const scrubStore = dependencies.scrubStore ?? scrubOpencodeStoreAccountState
  const spawnServer = dependencies.spawnServer ?? defaultSpawnServer
  const createClient = dependencies.createClient ?? defaultCreateClient
  const verifyIdentity = dependencies.verifyIdentity ?? verifyExecutionIdentity
  const verifyProviderInventory =
    dependencies.verifyProviderInventory ?? verifySelectedProviderInventory
  const verifySkillInventory = dependencies.verifySkillInventory ?? verifyPinnedSkillInventory
  const writeInventory = dependencies.writeInventory ?? writeVerifiedInventorySnapshot
  const random = dependencies.randomBytes ?? ((size) => randomBytes(size))
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? defaultSleep
  const readAck = dependencies.readAck ?? defaultReadAck
  const removeStore = dependencies.removeStore ?? defaultRemoveStore
  const serverStopGraceMs = dependencies.serverStopGraceMs ?? SERVER_STOP_GRACE_MS
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value))
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value))
  const signal = dependencies.signal

  verifyManifestDigests(manifest)
  const storeRoot = resolveStoreRoot(manifest)
  const credentials = serverCredentials(manifest)
  const sourceBefore = await scanSource(manifest.worktreePath)
  if (
    sourceBefore.canonicalWorktree !== manifest.worktreePath ||
    sourceBefore.digest !== manifest.sourceFingerprintDigest
  ) {
    return executionIdentityFailure('execution-identity-source-changed')
  }
  await verifySnapshot(manifest.binaryPath, manifest.officialBuildDigest)
  await runFffProbe({
    binaryPath: manifest.binaryPath,
    runRoot: manifest.runRoot,
    probe: manifest.fffProbe,
    timeoutMs: manifest.bootstrapTimeoutMs,
  })

  let lock: OpencodeStoreLifecycleLock | undefined
  let lockWasAcquired = false
  let lockWasReleased = false
  let child: VerifiedLauncherServerProcess | undefined
  let serverReaped = false
  let stdoutMonitor: StdoutMonitor | undefined
  let stderrPump: Promise<void> | undefined
  let client: VerifiedLauncherClient | undefined
  let sessionID: string | undefined
  let succeeded = false
  let launchFailed = false
  let launchFailure: unknown
  let cleanupFailure: unknown
  try {
    lock = await acquireStoreLock(
      manifest.sessionDbPath,
      manifest.storeKind === 'business' ? manifest.leaseNonce : undefined,
    )
    lockWasAcquired = true
    await scrubStore({
      dbPath: manifest.sessionDbPath,
      kind: manifest.mode === 'resume' ? 'existing' : 'fresh',
      lock,
    })

    // Reverify immediately before exec. Nothing below may switch back to the
    // registry/source executable.
    await verifySnapshot(manifest.binaryPath, manifest.officialBuildDigest)
    child = spawnServer({
      command: [
        manifest.binaryPath,
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
        '--no-mdns',
      ],
      cwd: manifest.worktreePath,
      env: manifest.serverEnv,
    })
    await bindStoreServer(lock, {
      pidNamespace: child.pid,
      binaryPath: manifest.binaryPath,
      officialBuildDigest: manifest.officialBuildDigest,
      // Do not consume the injected direct-codec clock: its monotonic sequence
      // is part of caller/assistant ID ordering, while this is audit metadata.
      startedAt: Date.now(),
      sessionStoreKey: manifest.sessionStoreKey,
      scope:
        manifest.storeKind === 'business'
          ? {
              kind: 'business',
              mode: manifest.mode,
              nodeRunId: manifest.nodeRunId,
            }
          : {
              kind: 'system-ephemeral',
              invocationId: manifest.invocationId,
            },
    })
    stdoutMonitor = monitorServerStdout(child.stdout)
    stderrPump = drainServerStderr(child.stderr)
    void stderrPump.catch(() => {})
    const runningChild = child
    const runningStdoutMonitor = stdoutMonitor

    const port = await runWithDeadline(
      () =>
        guardedByServer(runningStdoutMonitor.ready, runningChild, runningStdoutMonitor.violation),
      manifest.bootstrapTimeoutMs,
      'execution-identity-bootstrap-failed',
      signal,
      sleep,
    )
    const directClient = createClient({
      origin: `http://127.0.0.1:${port}`,
      directory: manifest.worktreePath,
      ...credentials,
      budgets: {
        maxJsonBytes: 4 * 1024 * 1024,
        requestTimeoutMs: Math.min(2_000, manifest.bootstrapTimeoutMs),
      },
    })
    client = directClient

    await runWithDeadline(
      (bootstrapSignal) =>
        guardedByServer(
          (async () => {
            const effectiveConfig = await directClient.getConfig(bootstrapSignal)
            const providers = await directClient.getConfigProviders(bootstrapSignal)
            const agents = await directClient.getAgents(bootstrapSignal)
            const skills = await directClient.getSkills(bootstrapSignal)
            const secondAgents = await directClient.getAgents(bootstrapSignal)
            verifyIdentity({
              expectedInlineConfig: manifest.expectedConfig,
              effectiveConfig,
              agents,
              secondAgents,
              selectedAgentName: manifest.selectedAgent,
              permissionHome: manifest.serverEnv.HOME,
            })
            verifyProviderInventory(providers, manifest.selectedModel)
            verifySkillInventory(skills)
            const sourceAfter = await scanSource(manifest.worktreePath)
            assertSourceFingerprintUnchanged(sourceBefore, sourceAfter)
            if (manifest.storeKind === 'business' && manifest.inventory.enabled) {
              const snapshot = buildVerifiedInventorySnapshot({
                // The second response is the one closest to the write. The
                // identity verifier has already proven its full canonical seal
                // equal to the first response from this same server instance.
                agents: secondAgents,
                plan: manifest.inventory,
                capturedAt: now(),
              })
              await writeInventory(manifest.runRoot, snapshot)
            }
            const session = await resolveSession(manifest, directClient, bootstrapSignal)
            sessionID = session.id
            if (
              identityDigest(expectedSessionContract(manifest)) !== manifest.sessionContractDigest
            ) {
              return executionIdentityFailure('execution-identity-session-mismatch')
            }
            if (manifest.storeKind === 'business') {
              writeStderr(
                `${buildSessionReadyMarker({
                  kind: manifest.mode,
                  sessionId: session.id,
                  projectId: session.projectID,
                  version: PINNED_OPENCODE_VERSION,
                  nodeRunId: manifest.nodeRunId,
                  leaseNonceDigest: manifest.leaseNonceDigest,
                })}\n`,
              )
              await waitForControlAck(manifest, {
                signal: bootstrapSignal,
                now,
                sleep,
                readAck,
              })
            }
          })(),
          runningChild,
          runningStdoutMonitor.violation,
        ),
      manifest.bootstrapTimeoutMs,
      'execution-identity-bootstrap-failed',
      signal,
      sleep,
    )
    if (sessionID === undefined) {
      return executionIdentityFailure('execution-identity-session-mismatch')
    }

    // The source fence is rechecked at the actual model boundary, after the
    // ownership ack and immediately before opening SSE/POST.
    const promptSource = await scanSource(manifest.worktreePath)
    assertSourceFingerprintUnchanged(sourceBefore, promptSource)
    await runWithDeadline(
      (runSignal) =>
        guardedByServer(
          runPromptStream({
            manifest,
            client: directClient,
            sessionID: sessionID!,
            signal: runSignal,
            random,
            now,
            sleep,
            writeStdout,
          }),
          runningChild,
          runningStdoutMonitor.violation,
        ),
      manifest.runTimeoutMs,
      'execution-identity-timeout',
      signal,
      sleep,
    )
    succeeded = true
  } catch (error) {
    launchFailed = true
    launchFailure = error
  } finally {
    if (!succeeded) await bestEffortAbort(client, sessionID)
    if (child !== undefined) {
      try {
        await stopServer(child, serverStopGraceMs)
        serverReaped = true
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    if (stdoutMonitor !== undefined) {
      const stdoutSettlement = await settleWithin(stdoutMonitor.done, serverStopGraceMs)
      if (stdoutSettlement.status === 'rejected') {
        const { error } = stdoutSettlement
        // A strict stdout violation is the primary bootstrap attestation
        // failure, not evidence that account-store cleanup failed.
        if (
          !(error instanceof LauncherPhaseError) ||
          error.code !== 'execution-identity-bootstrap-failed'
        ) {
          cleanupFailure ??= error
        }
      } else if (stdoutSettlement.status === 'timeout') {
        cleanupFailure ??= new Error('server-stdout-drain-timeout')
      }
    }
    if (stderrPump !== undefined) {
      const stderrSettlement = await settleWithin(stderrPump, serverStopGraceMs)
      if (stderrSettlement.status === 'rejected') {
        cleanupFailure ??= stderrSettlement.error
      } else if (stderrSettlement.status === 'timeout') {
        cleanupFailure ??= new Error('server-stderr-drain-timeout')
      }
    }
    if (lock !== undefined && (child === undefined || serverReaped)) {
      if (child !== undefined && serverReaped) {
        try {
          await scrubStore({
            dbPath: manifest.sessionDbPath,
            kind: manifest.mode === 'resume' ? 'existing' : 'fresh',
            lock,
          })
        } catch (error) {
          cleanupFailure ??= error
        }
      }
      try {
        await lock.release()
        lockWasReleased = true
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    // System stores remain available for the parent-side post-run capture and
    // are removed only by the awaited SpawnPlan.cleanup. The launcher owns
    // deletion solely for a failed fresh business chain that never became a
    // reusable successful session.
    if (
      manifest.storeKind === 'business' &&
      manifest.mode === 'new' &&
      !succeeded &&
      lockWasAcquired &&
      lockWasReleased
    ) {
      try {
        await removeStore(storeRoot)
      } catch (error) {
        cleanupFailure ??= error
      }
    }
  }
  if (cleanupFailure !== undefined) {
    throw new ExecutionIdentityFailure('execution-identity-store-unsafe')
  }
  if (launchFailed) throw launchFailure
}

/**
 * Hidden CLI boundary. It installs cancellation handlers, consumes/unlinks the
 * one-shot manifest, and emits exactly one stable failure line on error.
 */
export async function runVerifiedOpencodeLauncher(
  manifestPath: string,
  dependencies: VerifiedLauncherDependencies = {},
): Promise<number> {
  const readManifest = dependencies.readManifest ?? readAndUnlinkVerifiedLaunchManifest
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value))
  const controller = new AbortController()
  let signalExitCode = 0
  const onTerm = () => {
    signalExitCode = 143
    controller.abort(new LauncherCancelledError())
  }
  const onInt = () => {
    signalExitCode = 130
    controller.abort(new LauncherCancelledError())
  }
  if (dependencies.signal === undefined) {
    process.once('SIGTERM', onTerm)
    process.once('SIGINT', onInt)
  }
  const signal = dependencies.signal ?? controller.signal
  try {
    const manifest = await readManifest(manifestPath)
    await launchVerifiedOpencodeManifest(manifest, { ...dependencies, signal })
    return 0
  } catch (error) {
    if (error instanceof LauncherCancelledError || signal.aborted) {
      return signalExitCode === 0 ? 143 : signalExitCode
    }
    writeStderr(`AW_OPENCODE_FAILURE ${stableFailureCode(error)}\n`)
    return 1
  } finally {
    if (dependencies.signal === undefined) {
      process.removeListener('SIGTERM', onTerm)
      process.removeListener('SIGINT', onInt)
    }
  }
}
