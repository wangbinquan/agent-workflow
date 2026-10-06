// RFC-370: ordinary diagnostics use one selected prototype family and opaque
// execution identities; explicit native roots preserve original receipt reads.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import type { Mcp } from '@agent-workflow/shared'
import { buildActor, SYSTEM_USER_ID } from '@/auth/actor'
import { mcps, runtimes, mcpRuntimeTestSessions, mcpRuntimeTestTurns } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composeMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import { createMcpDiagnosticsApplication } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import { createLocalMcpDiagnosticsApplication } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import { createLocalMcpDiagnosticsEffects } from '@/modules/resource-catalog/infrastructure/local/mcpDiagnosticsEffects'
import type { McpDiagnosticsApplication } from '@/modules/resource-catalog/application/mcps/runtimeDiagnostics'
import type {
  McpDiagnosticsEffects,
  McpDiagnosticRuntime,
  McpDiagnosticRunResult,
  McpDiagnosticTurnStart,
  ResolvedTestRuntime,
} from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'
import type {
  McpRuntimeTestPersistence,
  McpRuntimeTestSessionRecord,
  McpRuntimeTestTurnRecord,
} from '@/modules/resource-catalog/application/mcps/runtimeTestPersistence'
import { ResourceOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { describeEachProvider } from './helpers/eachProvider'

const actor = buildActor({
  user: {
    id: SYSTEM_USER_ID,
    username: SYSTEM_USER_ID,
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})
const applications: McpDiagnosticsApplication[] = []
// Dispose inside the test callback, before provider cleanup restores bindings.
function applicationTest(name: string, action: () => Promise<void>) {
  test(name, async () => {
    try {
      await action()
    } finally {
      for (const app of applications.splice(0)) await app.dispose()
    }
  })
}

class PortableDiagnostics implements McpDiagnosticsEffects {
  #clock = 1000
  #starts = new WeakMap<object, Parameters<McpDiagnosticsEffects['captureTurnStart']>[0]>()
  #executions = new Map<string, object>()
  readonly calls: string[] = []
  readonly reaped: string[] = []
  readonly runtime: ResolvedTestRuntime
  hold = false
  failResolution: Error | null = null
  constructor(
    readonly persistence: McpRuntimeTestPersistence,
    row: McpDiagnosticRuntime,
  ) {
    this.runtime = {
      row,
      label: 'selected-runtime-display-only',
      target: { kind: 'mcp-diagnostic-runtime-target', reference: Object.freeze({}) },
      snapshotJson: JSON.stringify({ protocol: row.protocol, selected: 'portable-diagnostics' }),
    }
  }
  #receiver() {
    expect<PortableDiagnostics>(this).toBeInstanceOf(PortableDiagnostics)
  }
  now() {
    this.#receiver()
    return this.#clock
  }
  setTimeout(callback: () => void, delay: number) {
    this.#receiver()
    const timer = setTimeout(callback, delay)
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() }
  }
  setInterval(callback: () => void, delay: number) {
    this.#receiver()
    const timer = setInterval(callback, delay)
    return { cancel: () => clearInterval(timer), unref: () => timer.unref() }
  }
  async resolveRuntime(name: string | null) {
    this.#receiver()
    this.calls.push('resolve:' + name)
    if (this.failResolution !== null) throw this.failResolution
    return this.runtime
  }
  supportsSession() {
    this.#receiver()
    return true
  }
  createNativeSessionId(runtime: ResolvedTestRuntime) {
    this.#receiver()
    expect(runtime).toBe(this.runtime)
    return '2fb0be7c-1147-4b61-987e-bbd826b48505'
  }
  workspaceReference(id: string) {
    this.#receiver()
    return 'selected-workspace:' + id
  }
  workspaceExists(reference: string) {
    this.#receiver()
    return reference.startsWith('selected-workspace:')
  }
  cleanupWorkspace() {
    this.#receiver()
    return { cleanupState: 'complete' as const, cleanupErrorCode: null }
  }
  async currentMcpHash(mcp: Mcp) {
    this.#receiver()
    return mcpOperationConfigHashOf(mcp)
  }
  broadcast(id: string) {
    this.#receiver()
    this.calls.push('broadcast:' + id)
  }
  hasExecution(turn: McpRuntimeTestTurnRecord) {
    this.#receiver()
    return this.#executions.has(turn.id)
  }
  registerExecution(id: string) {
    this.#receiver()
    this.#executions.set(id, Object.freeze({}))
  }
  async reapTurn(turn: McpRuntimeTestTurnRecord, readNow: () => number) {
    this.#receiver()
    expect(readNow()).toBe(this.#clock)
    this.reaped.push(turn.id)
    this.#executions.delete(turn.id)
    return 'killed' as const
  }
  async recoverReapedTurn(input: Parameters<McpDiagnosticsEffects['recoverReapedTurn']>[0]) {
    this.#receiver()
    input.readNow()
    return true
  }
  captureTurnStart(
    input: Parameters<McpDiagnosticsEffects['captureTurnStart']>[0],
  ): McpDiagnosticTurnStart {
    this.#receiver()
    this.calls.push('capture:' + input.turn.id)
    const reference = Object.freeze({})
    this.#starts.set(reference, input)
    return { kind: 'mcp-diagnostic-turn-start', reference }
  }
  async runTurn(
    input: Parameters<McpDiagnosticsEffects['runTurn']>[0],
  ): Promise<McpDiagnosticRunResult> {
    this.#receiver()
    expect(input.runtime).toBe(this.runtime)
    const start = this.#starts.get(input.turnStart.reference)
    if (start === undefined) throw new Error('wrong selected start participant')
    expect(start.session).toBe(input.session)
    expect(start.turn).toBe(input.turn)
    await input.assertSpawnAllowed()
    // The fixture projects the original SQL receipt with no PID. Its selected
    // execution identity stays private, rather than occupying the PID column.
    const admitted = await this.persistence.recordSpawn({
      sessionId: start.session.id,
      turnId: start.turn.id,
      pid: null,
      spawnedAt: start.readNow(),
      spawnBinaryPath: input.runtime.label,
      fenceAt: start.readNow(),
    })
    if (!admitted) throw new Error('mcp-test-spawn-canceled-before-prompt')
    this.registerExecution(input.turn.id)
    this.calls.push('run:' + input.turn.id)
    const sessionId = input.session.runtimeSessionId!
    await input.sink.setRootSessionId(sessionId)
    await input.sink.append({
      ts: this.#clock,
      kind: 'text',
      payload: JSON.stringify({
        type: 'text',
        sessionID: sessionId,
        messageID: input.turn.id,
        part: { type: 'text', text: 'selected response' },
      }),
      sessionId,
      parentSessionId: null,
      source: 'stream',
      externalEventId: input.turn.id,
    })
    if (this.hold && !input.signal.aborted)
      await new Promise<void>((yes) =>
        input.signal.addEventListener('abort', () => yes(), { once: true }),
      )
    this.#executions.delete(input.turn.id)
    return {
      status: input.signal.aborted ? 'aborted' : 'ok',
      exitCode: input.signal.aborted ? null : 0,
      stderrTail: '',
      durationMs: 1,
      capturedSessionId: sessionId,
      verifyAfterCapture: async () => {
        this.#receiver()
        this.calls.push('verify:' + input.turn.id)
        return undefined
      },
    }
  }
  failedResult(
    _session: McpRuntimeTestSessionRecord,
    aborted: boolean,
    durationMs: number,
  ): McpDiagnosticRunResult {
    this.#receiver()
    return {
      status: aborted ? 'aborted' : 'spawn-failed',
      exitCode: null,
      stderrTail: '',
      durationMs,
      verifyAfterCapture: async () => undefined,
    }
  }
}

async function fixture(
  db: ProviderNeutralDatabase,
  protocol: McpDiagnosticRuntime['protocol'] = 'opencode',
) {
  await db
    .insert(runtimes)
    .values({ id: 'portable-runtime', name: 'portable', protocol, enabled: true })
  await db.insert(mcps).values({
    id: 'portable-mcp',
    name: 'portable',
    description: '',
    type: 'local',
    config: JSON.stringify({ command: ['unused-mcp'] }),
    enabled: true,
    ownerUserId: SYSTEM_USER_ID,
    visibility: 'private',
  })
  const catalog = composeMcpCatalog({
    db,
    coordinator: new ResourceOperationCoordinator(),
    nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
    runtime: { prepareDelete: async () => {}, reconcileDurableIntents: async () => {} },
    lifecycle: { transitionMutation: async () => {}, deletePrepared: async () => {} },
    resourceCatalog: composeResourceCatalogFor({ db }),
  })
  const authority = new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
  const mcp = await catalog.queries.get(authority, { id: 'portable-mcp' })
  if (mcp === null) throw new Error('missing real MCP fixture')
  const row: McpDiagnosticRuntime = {
    id: 'portable-runtime',
    name: 'portable',
    protocol,
    binaryPath: null,
    enabled: true,
    configDirEnv: null,
    configDirName: null,
    probeFence: 0,
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
  }
  const provider = composeMcpRuntimeTestProvider(db),
    effects = new PortableDiagnostics(provider.persistence, row)
  const app = createMcpDiagnosticsApplication({ ...provider, effects, loadMcp: async () => mcp })
  applications.push(app)
  return { db, mcp, row, provider, effects, app }
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('MCP selected family did not settle')
    await new Promise<void>((yes) => setTimeout(yes, 5))
  }
}
function request(mcp: Mcp) {
  return {
    expectedMcpConfigHash: mcpOperationConfigHashOf(mcp),
    runtimeName: 'portable',
    message: 'selected execution',
    clientCreateId: 'portable-create',
    clientMessageId: 'portable-message',
  }
}

describeEachProvider('RFC-370 selected complete MCP diagnostics family', (harness) => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    applicationTest(
      protocol + ' uses inherited effects, target/start identity, real receipts and capture',
      async () => {
        const h = await fixture(harness.db, protocol),
          input = request(h.mcp)
        const receipt = await h.app.create(actor, h.mcp, input)
        await waitFor(
          async () => (await h.app.get(actor, h.mcp.id, receipt.sessionId)).inFlightTurnId === null,
        )
        const replay = await h.app.create(actor, h.mcp, input)
        expect(replay).toEqual(receipt)
        expect(h.effects.calls.filter((call) => call.startsWith('run:'))).toEqual([
          'run:' + receipt.acceptedTurnId,
        ])
        expect(h.effects.calls).toContain('verify:' + receipt.acceptedTurnId)
        const saved = await h.provider.persistence.loadSession(receipt.sessionId)
        expect(saved?.runtimeBinaryPath).toBe('selected-runtime-display-only')
        expect(saved?.scratchRoot).toBe('selected-workspace:' + receipt.sessionId)
        const turn = await h.provider.persistence.loadTurn(receipt.acceptedTurnId)
        expect(turn?.pid).toBeNull()
        expect(turn?.status).toBe('succeeded')
        expect((await h.app.get(actor, h.mcp.id, receipt.sessionId)).nativeSessionReady).toBe(true)
      },
    )
  }
  applicationTest('selected resolution failures reserve no session or turn', async () => {
    const h = await fixture(harness.db),
      error = new Error('selected target unavailable')
    h.effects.failResolution = error
    await expect(h.app.create(actor, h.mcp, request(h.mcp))).rejects.toBe(error)
    expect(await harness.db.select().from(mcpRuntimeTestSessions)).toEqual([])
    expect(await harness.db.select().from(mcpRuntimeTestTurns)).toEqual([])
    expect(h.effects.calls.some((call) => call.startsWith('capture:'))).toBe(false)
  })
  applicationTest(
    'cancel reaches the same selected invocation and preserves durable canceled state',
    async () => {
      const h = await fixture(harness.db)
      h.effects.hold = true
      const receipt = await h.app.create(actor, h.mcp, request(h.mcp))
      await waitFor(async () => h.effects.calls.includes('run:' + receipt.acceptedTurnId))
      await h.app.cancel(actor, h.mcp.id, receipt.sessionId, { turnId: receipt.acceptedTurnId })
      await waitFor(
        async () => (await h.app.get(actor, h.mcp.id, receipt.sessionId)).inFlightTurnId === null,
      )
      expect((await h.provider.persistence.loadTurn(receipt.acceptedTurnId))?.status).toBe(
        'canceled',
      )
    },
  )
  applicationTest(
    'boot recovery selects opaque execution existence even when the legacy PID is null',
    async () => {
      const h = await fixture(harness.db)
      const receipt = await h.provider.persistence.create({
        mcpId: h.mcp.id,
        ownerUserId: actor.user.id,
        clientCreateId: 'boot-create',
        requestDigest: createHash('sha256').update('boot').digest('hex'),
        sessionId: 'portable-boot',
        turnId: 'portable-boot-turn',
        mcpConfigHash: mcpOperationConfigHashOf(h.mcp),
        runtimeRowId: h.row.id,
        runtimeName: h.row.name,
        runtimeProtocol: h.row.protocol,
        runtimeSnapshotJson: h.effects.runtime.snapshotJson,
        runtimeBinaryPath: h.effects.runtime.label,
        runtimeSessionId: null,
        scratchRoot: 'selected-workspace:portable-boot',
        message: 'boot',
        clientMessageId: 'boot-message',
        now: 1000,
        hardDeadlineAt: 301000,
        receiptExpiresAt: 601000,
      })
      expect((await h.provider.persistence.loadTurn(receipt.acceptedTurnId))?.pid).toBeNull()
      h.effects.registerExecution(receipt.acceptedTurnId)
      await h.app.start()
      expect(h.effects.reaped).toEqual([receipt.acceptedTurnId])
      expect((await h.provider.persistence.loadSession(receipt.sessionId))?.cleanupState).not.toBe(
        'quarantined',
      )
    },
  )
  applicationTest(
    'native now callback still receives the actual cold application snapshot',
    async () => {
      const h = await fixture(harness.db),
        receivers: unknown[] = []
      const native = createLocalMcpDiagnosticsApplication({
        ...h.provider,
        loadMcp: async () => h.mcp,
        loadRuntime: async () => h.row,
        isRuntimeEligible: () => true,
        configuration: { read: () => ({}) },
        appHome: '/unused/native-mcp',
        now: function (this: unknown) {
          receivers.push(this)
          return 1000
        },
      })
      applications.push(native)
      await native.start()
      expect(receivers.length).toBeGreaterThan(0)
      expect(receivers.every((receiver) => receiver === native)).toBe(true)
      expect(Reflect.get(Reflect.get(native, 'deps'), 'persistence')).toBe(h.provider.persistence)
    },
  )
  applicationTest(
    'native reap and quarantine qualification preserve receipt-before-clock reads',
    async () => {
      const h = await fixture(harness.db),
        order: string[] = [],
        receiver = Object.freeze({ native: true })
      const receipt = await h.app.create(actor, h.mcp, request(h.mcp))
      await waitFor(
        async () => (await h.app.get(actor, h.mcp.id, receipt.sessionId)).inFlightTurnId === null,
      )
      const saved = await h.provider.persistence.loadTurn(receipt.acceptedTurnId)
      if (saved === null) throw new Error('missing real turn')
      const turn = {
        ...saved,
        get pid() {
          order.push('pid')
          return 42
        },
        get startedAt() {
          order.push('startedAt')
          return 900
        },
        get spawnBinaryPath() {
          order.push('binary')
          return '/original/executable'
        },
        get id() {
          order.push('id')
          return saved.id
        },
      }
      const effects = createLocalMcpDiagnosticsEffects(
        {
          configuration: { read: () => ({}) },
          appHome: '/unused/native-mcp',
          loadRuntime: async () => h.row,
          isRuntimeEligible: () => true,
          killStaleRunProcessTree: async function (this: unknown, run, options) {
            expect(this).toBe(receiver)
            expect(run).toEqual({
              pid: 42,
              startedAt: 900,
              spawnBinaryPath: '/original/executable',
            })
            expect(options).toEqual({ now: 1000 })
            order.push('reap')
            return 'killed'
          },
        },
        {
          applicationReceiver: () => receiver,
          persistence: {
            recordSpawn: async () => {
              throw new Error('not a start')
            },
            recoverQuarantined: async (input) => {
              expect(input).toEqual({
                sessionId: receipt.sessionId,
                turnId: saved.id,
                expectedPid: 42,
                now: 1000,
              })
              order.push('recover')
              return true
            },
          },
        },
      )
      expect(
        await effects.reapTurn(turn, () => {
          order.push('clock')
          return 1000
        }),
      ).toBe('killed')
      expect(order).toEqual(['pid', 'startedAt', 'binary', 'clock', 'reap'])
      order.length = 0
      const session = await h.provider.persistence.loadSession(receipt.sessionId)
      if (session === null) throw new Error('missing real session')
      expect(
        await effects.recoverReapedTurn({
          session,
          turn,
          readNow: () => {
            order.push('clock')
            return 1000
          },
        }),
      ).toBe(true)
      expect(order).toEqual(['id', 'pid', 'clock', 'recover'])
      expect(
        await harness.db
          .select()
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, saved.id)),
      ).toHaveLength(1)
    },
  )
})

describe('RFC-370 native MCP root completeness', () => {
  // RFC-370: preserve complete original roots after the exact boot-family selection inverse.
  function inverseBootRecoveryBindings(source: ts.SourceFile, body: ts.Block) {
    let selections = 0
    const transformed = ts.transform(body, [
      (context) => {
        const inverse: ts.Visitor = (node) => {
          if (
            ts.isObjectLiteralExpression(node) &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression.getText(source) === 'runTaskExecutionBootRecovery'
          ) {
            const entries = node.properties.filter(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === 'recoveryEffects',
            ) as ts.PropertyAssignment[]
            expect(entries).toHaveLength(1)
            expect(entries[0]!.initializer.getText(source).replace(/\s/g, '')).toBe(
              'selectLocalBootExecutionRecoveryFactory(input.bootExecutionRecovery)',
            )
            selections++
            return ts.factory.updateObjectLiteralExpression(
              node,
              ts.factory.createNodeArray(
                node.properties
                  .filter((property) => property !== entries[0])
                  .map(
                    (property) => ts.visitNode(property, inverse, ts.isObjectLiteralElementLike)!,
                  ),
                node.properties.hasTrailingComma,
              ),
            )
          }
          return ts.visitEachChild(node, inverse, context)
        }
        return (node) => ts.visitNode(node, inverse, ts.isBlock)!
      },
    ])
    const original = transformed.transformed[0]!
    transformed.dispose()
    return { body: original, selections }
  }

  // RFC-370: preserve the old complete roots after the exact verification binding inverse.
  function inverseVerificationBindings(source: ts.SourceFile, body: ts.Block) {
    let selections = 0
    let forwards = 0
    const transformed = ts.transform(body, [
      (context) => {
        const inverse: ts.Visitor = (node) => {
          if (ts.isObjectLiteralExpression(node) && ts.isCallExpression(node.parent)) {
            const entries = node.properties.filter(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === 'verificationCommands',
            ) as ts.PropertyAssignment[]
            if (entries.length > 0) {
              expect(entries).toHaveLength(1)
              const callee = node.parent.expression.getText(source)
              const value = entries[0]!.initializer.getText(source).replace(/\s/g, '')
              if (callee === 'composeDevelopmentAutomation') {
                expect(value).toBe(
                  'input.verificationCommands===undefined?createLocalVerificationCommandEffectsFactory():input.verificationCommands',
                )
                selections++
              } else {
                expect(callee).toBe('composeSqliteAppDeps')
                expect(value).toBe('input.verificationCommands')
                forwards++
              }
              return ts.factory.updateObjectLiteralExpression(
                node,
                ts.factory.createNodeArray(
                  node.properties
                    .filter((property) => property !== entries[0])
                    .map(
                      (property) => ts.visitNode(property, inverse, ts.isObjectLiteralElementLike)!,
                    ),
                  node.properties.hasTrailingComma,
                ),
              )
            }
          }
          return ts.visitEachChild(node, inverse, context)
        }
        return (node) => ts.visitNode(node, inverse, ts.isBlock)!
      },
    ])
    const original = transformed.transformed[0]!
    transformed.dispose()
    return { body: original, selections, forwards }
  }

  const root = resolve(import.meta.dir, '../src'),
    printer = ts.createPrinter({ removeComments: true })
  const hash = (node: ts.Node, source: ts.SourceFile) =>
    createHash('sha256')
      .update(printer.printNode(ts.EmitHint.Unspecified, node, source))
      .digest('hex')
  test('all three native roots retain every original body statement and argument', () => {
    for (const [path, name, argumentHash, bodyHash, statements] of [
      [
        'server.ts',
        'composeSqliteApplicationDeps',
        '78bb7b9deea9d89cc1f40b14a1cef2584bb084a748a644969286b43371028e67',
        'b128a11c5e6ed305f628e71a830674fb2e97d250effa881976b3c751ab6e9570',
        56,
      ],
      [
        'cli/postgresqlDaemonApplication.ts',
        'composePostgresqlApplication',
        '05502ca3b61c121c0f5406ae775d4b3d9ff5308656c8afbe75e4b311067d94ec',
        'ac24f790d109b515b2cf38ea3ae50cfe582c9873981029e47cc36de0d1a000c5',
        164,
      ],
      [
        'cli/start.ts',
        'composeSqliteProviderSession',
        '2f05dd04ed84e3446c9634a61f92ae540ffce8a0c385570c94b39a50a1201432',
        '153cf10800a2f91b9025aa2ac51a86f6b759bcb74cd1485eab4a71e1103f7cec',
        180,
      ],
    ] as const) {
      const source = ts.createSourceFile(
        path,
        readFileSync(resolve(root, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )
      const fn = source.statements.find(
        (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
      )
      if (fn?.body === undefined) throw new Error('missing real native MCP root')
      const calls: ts.CallExpression[] = []
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source).includes('composeLocalMcpDiagnostics')
        )
          calls.push(node)
        ts.forEachChild(node, visit)
      }
      visit(fn.body)
      expect(calls).toHaveLength(1)
      expect(hash(calls[0]!.arguments[0]!, source)).toBe(argumentHash)
      const bootRecovery = inverseBootRecoveryBindings(source, fn.body)
      const verification = inverseVerificationBindings(source, bootRecovery.body)
      let scriptSelections = 0
      const transformed = ts.transform(verification.body, [
        (context) => {
          const inverse: ts.Visitor = (node) => {
            if (ts.isObjectLiteralExpression(node)) {
              const script = node.properties.filter(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  property.name.getText(source) === 'taskScriptRunsFor' &&
                  property.initializer.getText(source) === 'composeLocalTaskScriptRunFamily',
              )
              if (script.length > 0) {
                expect(script).toHaveLength(1)
                expect(
                  node.properties.some(
                    (property) =>
                      ts.isPropertyAssignment(property) &&
                      property.name.getText(source) === 'taskAgentRunsFor' &&
                      property.initializer.getText(source) === 'composeLocalTaskAgentRunFamilyFor',
                  ),
                ).toBe(true)
                scriptSelections++
                return ts.factory.updateObjectLiteralExpression(
                  node,
                  ts.factory.createNodeArray(
                    node.properties
                      .filter((property) => property !== script[0])
                      .map(
                        (property) =>
                          ts.visitNode(property, inverse, ts.isObjectLiteralElementLike)!,
                      ),
                    node.properties.hasTrailingComma,
                  ),
                )
              }
            }
            return ts.isIdentifier(node) && node.text === 'composeLocalMcpDiagnostics'
              ? ts.factory.createIdentifier('composeMcpDiagnostics')
              : ts.visitEachChild(node, inverse, context)
          }
          return (node) => ts.visitNode(node, inverse, ts.isBlock)!
        },
      ])
      expect(hash(transformed.transformed[0]!, source)).toBe(bodyHash)
      expect(transformed.transformed[0]!.statements.length).toBe(statements)
      expect(scriptSelections).toBe(1)
      expect(bootRecovery.selections).toBe(name === 'composeSqliteApplicationDeps' ? 0 : 1)
      expect(verification.selections).toBe(name === 'composeSqliteApplicationDeps' ? 0 : 1)
      expect(verification.forwards).toBe(name === 'composeSqliteProviderSession' ? 1 : 0)
      transformed.dispose()
      expect(source.text).toContain(
        "from '@/modules/resource-catalog/composition/localMcpDiagnostics'",
      )
    }
  })
})
