// RFC-394: profile factories preserve every hosted selection, construction order and host diagnostic.
import { expect, spyOn, test } from 'bun:test'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeStandaloneProfile } from '@/bootstrap/standalone'
import { composeCrewStationProfile } from '@/bootstrap/crewstation'
import { selectDeployment } from '@/bootstrap/deployment'
import { deploymentSelectionsOf, DEPLOYMENT_SELECTION_KEYS } from '@/bootstrap/deploymentSelections'
import type { DeploymentSelections, HostProbeInput } from '@/bootstrap/deploymentProfile'
import * as git from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import * as hosted from '@/modules/system-operations/composition/crewstationDeployment'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { createStandbyExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/standbyExecutionAuthority'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import {
  NULLABLE_SELECTIONS,
  REQUIRED_SELECTIONS,
  SESSION_FACTORY_SELECTIONS,
} from './helpers/deploymentSelectionPartition'

// The former hosted factory returned 70 keys: listen takes host/port and the host selector retires.
// This explicit list must not be derived from the production key table.
const HOSTED_SELECTION_KEYS = [
  'actionWorkspaceEffects',
  'actionWorkspaceEntries',
  'applicationConfiguration',
  'archivedNodeEvents',
  'beforeEventObservationWrite',
  'bootExecutionRecovery',
  'codeReviewArtifacts',
  'conflictMergeWorkspaceEffects',
  'contentStore',
  'credentials',
  'crewStationEvents',
  'customObserverPrograms',
  'databaseBackup',
  'databaseInstallation',
  'developmentPurposes',
  'developmentWorkspaceRepositoryPreparation',
  'employeeCaseWorkspaceEffects',
  'employeeInputArtifacts',
  'employeePrograms',
  'evidenceArtifacts',
  'executionAuthority',
  'fusionWorkspaceEffects',
  // RFC-431: graph-development artifacts are a selection (hosted: the evidence store itself).
  'graphDevelopmentArtifacts',
  'hostedBackgroundOwners',
  'humanGateArtifactRecovery',
  'initializeExecution',
  'intentArtifacts',
  'isolationWorkspaces',
  'maintenanceEffectsBootstrap',
  'mcpDiagnostics',
  'pluginInstaller',
  'programFixtureProcess',
  'recoveredExecutionTaskIds',
  'repositoryBaselines',
  'repositoryCandidateEffects',
  'repositoryGitWorkspaces',
  'repositoryPreparationEffects',
  'repositoryPublicationTransport',
  'repositoryRemote',
  'repositoryRevisionContent',
  'resourcePackagePluginArtifacts',
  'resourcePackageSkillArtifacts',
  'reviewArtifacts',
  'reviewRollbackSnapshots',
  'runtimeInventoryContent',
  'runtimeManagement',
  'scratchWorkspaceEffects',
  'secretBox',
  'skillContent',
  'systemAgentRunFamily',
  'taskArchive',
  'taskDeletionEffects',
  'taskInputFiles',
  'taskRecovery',
  'taskRunSelection',
  'verificationCommands',
  'workspaceContent',
  'workspaceExcludeProfiles',
  'workspaceMaintenanceFilesystem',
  'workspacePresence',
  'workspaceReads',
  'workspaceUploads',
] as const satisfies readonly (keyof DeploymentSelections)[]
function probeInput(defaultRuntime: 'opencode' | 'claude-code' = 'opencode') {
  const log = createLogger('rfc394-probe')
  const info = spyOn(log, 'info').mockImplementation(() => {})
  const warn = spyOn(log, 'warn').mockImplementation(() => {})
  const error = spyOn(log, 'error').mockImplementation(() => {})
  return {
    input: { log, config: { ...DEFAULT_CONFIG, defaultRuntime } } satisfies HostProbeInput,
    info,
    warn,
    error,
    restore() {
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
    },
  }
}
// RFC-425 added the sixth profile field, `frontendMarker` (the SPA marker that used to come from the authority).
test('standalone selection needs no environment and has exactly the six profile fields', async () => {
  const profile = composeStandaloneProfile()
  expect(Object.keys(profile).sort()).toEqual([
    'frontendMarker',
    'kind',
    'listen',
    'probeHost',
    'requiredProvider',
    'selections',
  ])
  expect(profile).toMatchObject({
    kind: 'standalone',
    frontendMarker: null,
    requiredProvider: null,
    listen: {},
  })
  // RFC-431: the standalone profile states the required and hosted-only selections, nothing else.
  const stated = [...REQUIRED_SELECTIONS, ...NULLABLE_SELECTIONS].sort()
  expect(Object.keys(profile.selections).sort()).toEqual(stated)
  for (const key of NULLABLE_SELECTIONS) expect(profile.selections[key]).toBeNull()
  const selected = await selectDeployment({ CS_PROJECT: 'does-not-select-hosting' }).profile()
  expect(selected.kind).toBe('standalone')
  expect(Object.keys(selected.selections).sort()).toEqual(stated)
  // RFC-427: the mode is read when the deployment is selected; the hosted profile still checks its inputs.
  expect(() => selectDeployment({ AW_DEPLOYMENT_MODE: 'invalid' })).toThrow('AW_DEPLOYMENT_MODE')
  await expect(selectDeployment({ AW_DEPLOYMENT_MODE: 'crewstation' }).profile()).rejects.toThrow(
    'CS_PROJECT',
  )
})
test('selection projection preserves all receivers and excludes session-only fields', () => {
  const values = Object.fromEntries(
    Object.keys(DEPLOYMENT_SELECTION_KEYS).map((key) => [key, Object.freeze({ key })]),
  ) as unknown as DeploymentSelections
  const selected = deploymentSelectionsOf({
    ...values,
    token: 'private-session-input',
    requiredProvider: null,
  })
  expect(Object.keys(selected).sort()).toEqual(Object.keys(DEPLOYMENT_SELECTION_KEYS).sort())
  for (const key of Object.keys(DEPLOYMENT_SELECTION_KEYS) as (keyof DeploymentSelections)[])
    expect(selected[key]).toBe(values[key])
  expect('token' in selected).toBe(false)
  expect('requiredProvider' in selected).toBe(false)
  // RFC-428: four dead / shadowed selections retired (72 → 68); RFC-429: the evidence group (68 → 64);
  // RFC-430: three derivable selections (64 → 61); RFC-431: graph-development artifacts (61 → 62).
  expect(Object.keys(DEPLOYMENT_SELECTION_KEYS)).toHaveLength(62)
})
for (const version of ['git version 2.37.9', null])
  test('incompatible standalone git returns the unchanged fatal message: ' + version, async () => {
    const f = probeInput('claude-code')
    const caps = git.capabilitiesFromVersion(version === null ? null : git.parseGitVersion(version))
    const detect = spyOn(git, 'detectGitCapabilities').mockResolvedValue(caps)
    const runtime = spyOn(getRuntimeDriver('claude-code'), 'probe')
    try {
      expect(await composeStandaloneProfile().probeHost(f.input)).toBe(
        `agent-workflow: ${git.mergeTreeGateError(caps)}\n` +
          `  upgrade git to >= ${git.MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`,
      )
      expect(f.error).toHaveBeenCalledWith('git incompatible', {
        found: caps.version?.raw ?? null,
        requiredMinimum: git.MIN_GIT_VERSION,
      })
      expect(runtime).not.toHaveBeenCalled()
      expect(f.info).not.toHaveBeenCalled()
    } finally {
      runtime.mockRestore()
      detect.mockRestore()
      f.restore()
    }
  })
for (const compatible of [false, true])
  test('the configured claude-code probe remains soft: ' + compatible, async () => {
    const f = probeInput('claude-code')
    const caps = git.capabilitiesFromVersion(git.parseGitVersion('git version 2.38.0'))
    const detect = spyOn(git, 'detectGitCapabilities').mockResolvedValue(caps)
    const driver = getRuntimeDriver('claude-code')
    const probe = spyOn(driver, 'probe').mockResolvedValue({
      binary: 'claude',
      version: compatible ? '2.0.0' : null,
      compatible,
      incompatibleReason: compatible ? undefined : 'missing fixture binary',
    })
    try {
      expect(await composeStandaloneProfile().probeHost(f.input)).toBeNull()
      expect(f.info).toHaveBeenCalledWith('git probe ok', { version: 'git version 2.38.0' })
      expect(probe).toHaveBeenCalledWith(driver.defaultBinary(f.input.config)[0]!)
      if (compatible) {
        expect(f.info).toHaveBeenCalledWith('claude-code probe ok', {
          version: '2.0.0',
          binary: 'claude',
        })
        expect(f.warn).not.toHaveBeenCalled()
      } else
        expect(f.warn).toHaveBeenCalledWith(
          'claude-code default runtime unavailable (nodes selecting it will fail)',
          {
            binary: 'claude',
            found: null,
            requiredMinimum: driver.minVersion,
            reason: 'missing fixture binary',
          },
        )
      expect(f.error).not.toHaveBeenCalled()
    } finally {
      probe.mockRestore()
      detect.mockRestore()
      f.restore()
    }
  })
test('another default runtime does not trigger a claude-code probe', async () => {
  const f = probeInput()
  const detect = spyOn(git, 'detectGitCapabilities').mockResolvedValue(
    git.capabilitiesFromVersion(git.parseGitVersion('git version 2.50.1')),
  )
  const probe = spyOn(getRuntimeDriver('claude-code'), 'probe')
  try {
    expect(await composeStandaloneProfile().probeHost(f.input)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  } finally {
    probe.mockRestore()
    detect.mockRestore()
    f.restore()
  }
})

describeEachProvider('RFC-394 hosted factory with provider-owned storage', (harness) => {
  test('factory and selector retain the exact hosted keys and verify database before reading capabilities', async () => {
    const order: string[] = []
    const prepared = {
      databaseConfig: { provider: 'postgresql' },
      runtime: { runtime: {}, generation: { payload: { generationId: 'rfc394' } } },
    } as unknown as Awaited<ReturnType<typeof hosted.prepareCrewStationDatabase>>
    const prepare = spyOn(hosted, 'prepareCrewStationDatabase').mockImplementation(async () => {
      order.push('verify-database')
      return prepared
    })
    const config = composeApplicationConfigurationBinding({
      kind: 'file',
      configPath: '/unused/rfc394/config.json',
    })
    const system: hosted.CrewStationSystemSelections = {
      database: harness.db,
      applicationConfiguration: config,
      databaseInstallation: {} as hosted.CrewStationSystemSelections['databaseInstallation'],
      executionAuthority: {
        ...createStandbyExecutionAuthority({ reason: 'fixture' }),
        instanceId: 'rfc394',
        start() {},
        drainMigrationWith() {},
      },
      mutationFence: {
        current: () => {
          throw new Error('factory must not acquire execution')
        },
        assertHeld: async () => {},
      },
      platform: {
        async get<T>() {
          order.push('read-capabilities')
          return { protocolVersion: 3, releaseId: 'rfc394', agentProfiles: [] } as T
        },
        async post() {
          throw new Error('factory must not dispatch')
        },
        async *stream<T>(): AsyncGenerator<T> {
          yield* []
        },
      },
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 39)),
    }
    const compose = spyOn(hosted, 'composeCrewStationSystemSelections').mockImplementation(
      async ({ prepared: received }) => {
        expect(received).toBe(prepared)
        order.push('compose-system')
        return system
      },
    )
    const env = {
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: 'aw',
      CS_SERVICE: 'backend',
      CS_DATABASE_URL: 'postgres://fixture/aw',
      CS_JWKS_URL: 'http://fixture/jwks',
      CS_PLATFORM_API_URL: 'http://fixture',
      CS_OBJECTS_URL: 'http://fixture/objects',
      CS_OBJECT_SPACE_ID: 'rfc394',
      PORT: '4010',
      AW_SECRET_KEY: Buffer.alloc(32, 39).toString('base64'),
      AW_AGENT_PROFILES: JSON.stringify([
        {
          protocol: 'opencode',
          model: null,
          agentProfileId: '00000000-0000-4000-8000-000000000394',
        },
      ]),
    }
    const f = probeInput('claude-code')
    const detect = spyOn(git, 'detectGitCapabilities')
    const probe = spyOn(getRuntimeDriver('claude-code'), 'probe')
    try {
      for (const factory of [
        composeCrewStationProfile,
        (environment: typeof env) => selectDeployment(environment).profile(),
      ]) {
        order.length = 0
        const profile = await factory(env)
        expect(order).toEqual(['verify-database', 'compose-system', 'read-capabilities'])
        expect(profile.kind).toBe('crewstation')
        expect(profile.requiredProvider).toBe('postgresql')
        expect(profile.listen).toEqual({ host: '0.0.0.0', port: 4010 })
        expect(profile.frontendMarker).toBe('crewstation')
        expect(Object.keys(profile).sort()).toEqual([
          'frontendMarker',
          'kind',
          'listen',
          'probeHost',
          'requiredProvider',
          'selections',
        ])
        expect(Object.keys(profile.selections).sort()).toEqual([...HOSTED_SELECTION_KEYS].sort())
        // RFC-428: the shadowed portArtifactContentEffects left the hosted selections (69 → 68);
        // RFC-429: the evidence group collapsed into evidenceArtifacts (68 → 64);
        // RFC-430: three derivable selections left (64 → 61); RFC-431: graph-development artifacts (62).
        expect(HOSTED_SELECTION_KEYS).toHaveLength(62)
        expect(profile.selections.graphDevelopmentArtifacts).toBe(
          profile.selections.evidenceArtifacts,
        )
        // RFC-432: each session-scoped selection is a closure over the one object the profile built.
        for (const key of SESSION_FACTORY_SELECTIONS) {
          const factory = profile.selections[key] as (session: never) => unknown
          expect(typeof factory).toBe('function')
          const built = factory(undefined as never)
          expect(built).toBeDefined()
          expect(factory(undefined as never)).toBe(built)
        }
        expect(profile.selections.applicationConfiguration).toBe(system.applicationConfiguration)
        expect(profile.selections.databaseInstallation).toBe(system.databaseInstallation)
        expect(profile.selections.secretBox).toBe(system.secretBox)
        expect(await profile.probeHost(f.input)).toBeNull()
        expect(f.info).toHaveBeenCalledWith(
          'execution runs on the platform; local git and runtime probes skipped',
        )
        expect(detect).not.toHaveBeenCalled()
        expect(probe).not.toHaveBeenCalled()
        await profile.selections.executionAuthority!.close()
      }
    } finally {
      probe.mockRestore()
      detect.mockRestore()
      compose.mockRestore()
      prepare.mockRestore()
      f.restore()
    }
  })
})
