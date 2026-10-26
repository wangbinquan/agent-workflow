import * as epochBoot from '@/modules/system-operations/composition/epochBootAdmission'
// RFC-394: exercise the real startup sequence for listen precedence, profile forwarding and fatal probes.
import { expect, mock, spyOn, test } from 'bun:test'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { startCommand } from '@/bootstrap/daemonStart'
import type { DeploymentProfile, DeploymentSelections } from '@/bootstrap/deploymentProfile'
import type { DevelopmentOverlay } from '@/bootstrap/developmentReload'
import * as sessionGraph from '@/bootstrap/daemonSession'
import type { ComposedDaemonProviderSession } from '@/bootstrap/daemonSessionInput'
import * as bootstrap from '@/bootstrap/daemonProviderBootstrap'
import * as operations from '@/modules/system-operations/composition'
import * as database from '@/modules/system-operations/composition/daemonDatabase'
import * as migrations from '@/util/migrationsFolder'
import * as logging from '@/util/log'
import * as tokens from '@/auth/token'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'

function fixture(input: {
  launch?: { host?: string; port?: number }
  listen?: DeploymentProfile['listen']
  fatal?: string | null
  development?: DevelopmentOverlay
}) {
  const events: string[] = []
  const stop = new Error('rfc394-stop-before-listening')
  const exit = new Error('rfc394-process-exit')
  const log = logging.createLogger('rfc394-start')
  const configuration = { ...DEFAULT_CONFIG, bindHost: 'config-host', bindPort: 6100 }
  const release = mock(async () => {
    await Promise.resolve()
    events.push('release')
  })
  const lease: operations.DaemonStartupLease = {
    diagnostics: {},
    release,
    releaseOnExit() {},
    recoveryAuthority: ({ daemonGeneration }) => ({
      daemonGeneration,
      acquiredAt: 1,
      receiptDigest: 'fixture',
    }),
  }
  const applicationConfiguration = composeApplicationConfigurationBinding({
    kind: 'file',
    configPath: '/unused/rfc394/config.json',
    queries: { read: async () => configuration },
  })
  const taskArchive = {} as NonNullable<DeploymentSelections['taskArchive']>
  const profile: DeploymentProfile = {
    kind: 'standalone',
    requiredProvider: null,
    listen: input.listen ?? {},
    selections: {
      startupLease: { acquire: async () => lease },
      applicationConfiguration,
      taskArchive,
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 39)),
    },
    probeHost: mock(async (facts) => {
      expect(Object.keys(facts).sort()).toEqual(['config', 'log'])
      expect(facts.config).toBe(configuration)
      expect(facts.log).toBe(log)
      events.push('probe')
      return input.fatal ?? null
    }),
  }
  const configLogger = spyOn(logging, 'configureLogger').mockImplementation(() => {})
  const createLogger = spyOn(logging, 'createLogger').mockReturnValue(log)
  const migration = spyOn(migrations, 'resolveMigrationsFolder').mockResolvedValue(
    '/unused/rfc394/migrations',
  )
  const epochFacts = spyOn(epochBoot, 'readEpochBootFacts').mockReturnValue({
    sourceExists: false,
    pointer: null,
    provider: 'sqlite',
    operation: null,
    rfc349Operation: null,
    activationReceiptDigest: null,
    targetState: null,
    rollbackIncomplete: false,
  })
  const recovery = spyOn(operations, 'prepareDatabasePreOpenRecovery').mockResolvedValue({
    history: {},
    applyStagedRestore: async () => false,
  } as unknown as Awaited<ReturnType<typeof operations.prepareDatabasePreOpenRecovery>>)
  const prepared = spyOn(database, 'prepareDaemonDatabaseProviderForBoot').mockResolvedValue({
    databaseConfig: { provider: 'sqlite' },
    runtime: { provider: 'sqlite', generation: { payload: { generationId: 'rfc394' } } },
  } as Awaited<ReturnType<typeof database.prepareDaemonDatabaseProviderForBoot>>)
  const token = spyOn(tokens, 'ensureTokenFile').mockReturnValue('rfc394-token')
  const session = {
    application: { core: { authRuntime: { isBootstrapRequired: async () => false } } },
    session: { resume: async () => {} },
  } as unknown as ComposedDaemonProviderSession
  const composeSession = spyOn(sessionGraph, 'composeDaemonSession').mockResolvedValue(session)
  const composeBootstrap = spyOn(bootstrap, 'composeDaemonProviderBootstrap').mockImplementation(
    async <Application, WebSocket>(
      options: bootstrap.ComposeDaemonProviderBootstrapInput<Application, WebSocket>,
    ) => {
      const initial = await options.composeInitial(
        {} as Parameters<typeof options.composeInitial>[0],
      )
      return { initial, bootstrap: {} as bootstrap.DaemonProviderBootstrap<WebSocket> }
    },
  )
  const serve = spyOn(Bun, 'serve').mockImplementation(() => {
    throw stop
  })
  const error = spyOn(console, 'error').mockImplementation((message) => {
    events.push('print:' + String(message))
  })
  const terminate = spyOn(process, 'exit').mockImplementation((): never => {
    events.push('exit')
    throw exit
  })
  return {
    profile,
    lease,
    applicationConfiguration,
    taskArchive,
    prepared,
    composeSession,
    serve,
    terminate,
    events,
    stop,
    exit,
    run: () => startCommand(profile, input.launch ?? {}, input.development),
    restore() {
      terminate.mockRestore()
      error.mockRestore()
      serve.mockRestore()
      composeBootstrap.mockRestore()
      composeSession.mockRestore()
      token.mockRestore()
      prepared.mockRestore()
      recovery.mockRestore()
      epochFacts.mockRestore()
      migration.mockRestore()
      createLogger.mockRestore()
      configLogger.mockRestore()
    },
  }
}
for (const [name, launch, listen, expected] of [
  ['config fallback', {}, {}, { hostname: 'config-host', port: 6100 }],
  [
    'profile defaults',
    {},
    { host: 'profile-host', port: 6200 },
    { hostname: 'profile-host', port: 6200 },
  ],
  [
    'CLI overrides',
    { host: 'cli-host', port: 6300 },
    { host: 'profile-host', port: 6200 },
    { hostname: 'cli-host', port: 6300 },
  ],
  [
    'independent host fallback and ephemeral port',
    { port: 0 },
    { host: 'profile-host' },
    { hostname: 'profile-host', port: 0 },
  ],
] as const)
  test('listen precedence: ' + name, async () => {
    const f = fixture({ launch, listen })
    try {
      await expect(f.run()).rejects.toThrow(f.stop.message)
      expect(f.serve.mock.calls[0]![0]).toMatchObject(expected)
      expect(f.composeSession).toHaveBeenCalledTimes(1)
      const received = f.composeSession.mock.calls[0]![0]
      expect(received.requiredProvider).toBeNull()
      expect(received.taskArchive).toBe(f.taskArchive)
      expect(received.applicationConfiguration).toBe(f.applicationConfiguration)
      expect(received.secretBox).toBe(f.profile.selections.secretBox!)
      expect(received.startupLease).toBe(f.profile.selections.startupLease)
      expect(received).not.toHaveProperty('runtimeLegacyConfiguration')
      for (const key of [
        'workspaceUploads',
        'isolationWorkspaces',
        'repositoryGitWorkspaces',
        'workspaceReads',
      ] as const)
        expect(received[key]).toBeDefined()
      expect(f.terminate).not.toHaveBeenCalled()
    } finally {
      f.restore()
    }
  })
for (const fatal of ['fatal host diagnostic', ''])
  test(
    'every non-null probe result prints, awaits release and exits 1: ' + JSON.stringify(fatal),
    async () => {
      const f = fixture({ fatal })
      try {
        await expect(f.run()).rejects.toThrow(f.exit.message)
        expect(f.events.slice(0, 4)).toEqual(['probe', 'print:' + fatal, 'release', 'exit'])
        expect(f.terminate).toHaveBeenCalledWith(1)
        expect(f.prepared).not.toHaveBeenCalled()
        expect(f.composeSession).not.toHaveBeenCalled()
        expect(f.serve).not.toHaveBeenCalled()
      } finally {
        f.restore()
      }
    },
  )
test('the development overlay reaches host lifecycle and database integrity without entering selections', async () => {
  const daemonHost: DevelopmentOverlay['daemonHost'] = {
    readCurrent: () => null,
    publishReady() {},
    withdrawReady() {},
    subscribeShutdown: () => ({ close() {} }),
    announceReady() {},
    terminate: () => new Promise<never>(() => {}),
  }
  const development = { daemonHost, developmentIntegrity: { validatedDatabase: 'rfc394' } }
  const f = fixture({ development })
  try {
    await expect(f.run()).rejects.toThrow(f.stop.message)
    expect(f.composeSession.mock.calls[0]![0].daemonRuntime).toBe(daemonHost)
    expect(f.prepared.mock.calls[0]![0].file.sqliteOptions.developmentIntegrity).toBe(
      development.developmentIntegrity,
    )
    expect('daemonHost' in f.profile.selections).toBe(false)
    expect('developmentIntegrity' in f.profile.selections).toBe(false)
  } finally {
    f.restore()
  }
})
