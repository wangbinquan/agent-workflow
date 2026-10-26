// RFC-394: profile factories preserve every hosted selection, construction order and host diagnostic.
import { expect, spyOn, test } from 'bun:test'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeStandaloneProfile } from '@/bootstrap/standalone'
import { composeCrewStationProfile } from '@/bootstrap/crewstation'
import { selectDeploymentProfile } from '@/bootstrap/deployment'
import { deploymentSelectionsOf, DEPLOYMENT_SELECTION_KEYS } from '@/bootstrap/deploymentSelections'
import type { DeploymentSelections, HostProbeInput } from '@/bootstrap/deploymentProfile'
import * as git from '@/services/gitVersion'
import { getRuntimeDriver } from '@/services/runtime'
import * as hosted from '@/modules/system-operations/composition/crewstationDeployment'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { createStandbyExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/standbyExecutionAuthority'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

// The former hosted factory returned 70 keys: listen takes host/port and the host selector retires.
// This explicit list must not be derived from the production key table.
const HOSTED_SELECTION_KEYS = [
  'actionWorkspaceEffects',
  'actionWorkspaceEntries',
  'applicationConfiguration',
  'archivedNodeEvents',
  'attemptContext',
  'automationWorkspaceEffects',
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
  'evidenceDocumentCommands',
  'evidenceRead',
  'executionAuthority',
  'fusionWorkspaceEffects',
  'historyRestrictions',
  'hostedBackgroundOwners',
  'humanGateArtifactRecovery',
  'initializeExecution',
  'intentArtifacts',
  'isolationWorkspaces',
  'maintenanceEffectsBootstrap',
  'mcpDiagnostics',
  'missionInputBlobs',
  'pluginInstaller',
  'portArtifactContentEffects',
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
  'resourcePackageSkillContent',
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
test('standalone selection needs no environment and has exactly the five profile fields', async () => {
  const profile = composeStandaloneProfile()
  expect(Object.keys(profile).sort()).toEqual([
    'kind',
    'listen',
    'probeHost',
    'requiredProvider',
    'selections',
  ])
  expect(profile).toMatchObject({
    kind: 'standalone',
    requiredProvider: null,
    listen: {},
    selections: {},
  })
  expect(await selectDeploymentProfile({ CS_PROJECT: 'does-not-select-hosting' })).toMatchObject({
    kind: 'standalone',
    selections: {},
  })
  await expect(selectDeploymentProfile({ AW_DEPLOYMENT_MODE: 'invalid' })).rejects.toThrow(
    'AW_DEPLOYMENT_MODE',
  )
  await expect(selectDeploymentProfile({ AW_DEPLOYMENT_MODE: 'crewstation' })).rejects.toThrow(
    'CS_PROJECT',
  )
})
test('selection projection preserves all receivers and excludes session-only fields', () => {
  const values = Object.fromEntries(
    Object.keys(DEPLOYMENT_SELECTION_KEYS).map((key) => [key, Object.freeze({ key })]),
  ) as DeploymentSelections
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
  expect(Object.keys(DEPLOYMENT_SELECTION_KEYS)).toHaveLength(72)
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
      for (const factory of [composeCrewStationProfile, selectDeploymentProfile]) {
        order.length = 0
        const profile = await factory(env)
        expect(order).toEqual(['verify-database', 'compose-system', 'read-capabilities'])
        expect(profile.kind).toBe('crewstation')
        expect(profile.requiredProvider).toBe('postgresql')
        expect(profile.listen).toEqual({ host: '0.0.0.0', port: 4010 })
        expect(Object.keys(profile).sort()).toEqual([
          'kind',
          'listen',
          'probeHost',
          'requiredProvider',
          'selections',
        ])
        expect(Object.keys(profile.selections).sort()).toEqual([...HOSTED_SELECTION_KEYS].sort())
        expect(HOSTED_SELECTION_KEYS).toHaveLength(69)
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
