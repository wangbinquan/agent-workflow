// RFC-370 M0 — the CrewStation-hosted control plane around the shared boot
// (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §3.1, §3.2, §3.7, §5.1).
// Locks: the deployment is chosen explicitly and the hosted inputs are all
// validated at once; a hosted standby instance serves HTTP while its background
// set waits for execution authority (standalone factories are untouched);
// leaving authority exits non-zero through the normal drain; capabilities not
// available yet are refused with their reason; the SPA learns the deployment
// from the served page; the platform probes answer without authority; and the
// Manifest is rendered from a validated profile.
import { expect, test } from 'bun:test'
import { DomainError } from '@/util/errors'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import {
  composeDeploymentStartOptions,
  DeploymentModeError,
  readDeploymentMode,
} from '@/cli/deployment'
import { createExecutionExitRequests, startOnExecutionActive } from '@/cli/executionActivation'
import type { DaemonProviderRuntimeHandleFactory } from '@/cli/daemonProviderRuntimeSession'
import { getEmbeddedFrontendResponse, withDeploymentMarker } from '@/embed'
import {
  createPluginOperationDescriptors,
  createResourcePackageOperationDescriptors,
} from '@/modules/resource-catalog/composition/catalogOperationDescriptors'
import { invokeOperation } from '@/platform/operations/invoke'
import { runDaemonHostApplication } from '@/modules/system-operations/application/daemonHostApplication'
import type { ExecutionFence } from '@/modules/system-operations/application/ports/executionAuthority'
import {
  CrewStationEnvironmentError,
  readCrewStationDatabaseEnvironment,
  readCrewStationEnvironment,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { createStandbyExecutionAuthority } from '@/modules/system-operations/infrastructure/crewstation/standbyExecutionAuthority'
import { mountHealthRoutes } from '@/routes/health'
import {
  parseDeploymentProfile,
  renderCrewStationManifest,
} from '../../../scripts/lib/crewstation-manifest'

const KEY = Buffer.alloc(32, 7).toString('base64')
const HOSTED_ENV = {
  CS_PROJECT: 'agent-workflow',
  CS_SERVICE: 'agent-workflow',
  CS_DATABASE_URL: 'postgres://u:p@db:5432/aw',
  CS_JWKS_URL: 'http://api.svc.cs.internal/.well-known/jwks.json',
  CS_PLATFORM_API_URL: 'http://api.svc.cs.internal',
  PORT: '3000',
  AW_SECRET_KEY: KEY,
}

test('the deployment is selected explicitly; standalone needs nothing', async () => {
  expect(readDeploymentMode({})).toBe('standalone')
  expect(readDeploymentMode({ AW_DEPLOYMENT_MODE: 'standalone' })).toBe('standalone')
  expect(readDeploymentMode({ AW_DEPLOYMENT_MODE: 'crewstation' })).toBe('crewstation')
  // Platform variables alone never switch the deployment.
  expect(readDeploymentMode(HOSTED_ENV)).toBe('standalone')
  expect(() => readDeploymentMode({ AW_DEPLOYMENT_MODE: 'cloud' })).toThrow(DeploymentModeError)
  expect(await composeDeploymentStartOptions({})).toEqual({})
})

test('hosted inputs are validated at once and parsed', () => {
  const environment = readCrewStationEnvironment({
    ...HOSTED_ENV,
    AW_ADMIN_SUBJECTS: ' user:a, b  user:a ',
    CS_OBJECTS_URL: 'http://objects/v3/objects',
  })
  expect(environment).toMatchObject({
    project: 'agent-workflow',
    service: 'agent-workflow',
    port: 3000,
    objectsUrl: 'http://objects/v3/objects',
    objectSpaceId: null,
    adminSubjects: ['user:a', 'user:b'],
  })
  expect(environment.secretKey.equals(Buffer.alloc(32, 7))).toBe(true)
  expect(readCrewStationEnvironment(HOSTED_ENV).objectsUrl).toBeNull()

  let error: unknown
  try {
    readCrewStationEnvironment({
      PORT: '99999',
      AW_SECRET_KEY: 'c2hvcnQ=',
      CS_JWKS_URL: 'relative',
    })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(CrewStationEnvironmentError)
  expect((error as CrewStationEnvironmentError).problems).toEqual([
    'CS_PROJECT is required',
    'CS_SERVICE is required',
    'CS_DATABASE_URL is required',
    'CS_PLATFORM_API_URL is required',
    'PORT must be a TCP port number, got "99999"',
    'CS_JWKS_URL must be an absolute URL',
    'AW_SECRET_KEY must be 32 random bytes encoded as base64 (for example `openssl rand -base64 32`)',
  ])
  expect(readCrewStationDatabaseEnvironment(HOSTED_ENV)).toEqual({
    project: 'agent-workflow',
    service: 'agent-workflow',
  })
  expect(() => readCrewStationDatabaseEnvironment({ CS_PROJECT: 'p' })).toThrow(
    CrewStationEnvironmentError,
  )
})

test('a hosted M0 instance stays on standby with its reason', async () => {
  const authority = createStandbyExecutionAuthority({ reason: 'remote-execution-not-available' })
  expect(authority.mode).toBe('crewstation')
  expect(authority.current()).toEqual({ kind: 'standby', reason: 'remote-execution-not-available' })
  const outcome = await Promise.race([
    authority.whenActive().then(() => 'active'),
    new Promise((resolve) => setTimeout(() => resolve('still-standby'), 20)),
  ])
  expect(outcome).toBe('still-standby')
  expect(typeof authority.onLost(() => {})).toBe('function')
})

function controllableAuthority(kind: 'active' | 'standby') {
  let activate!: (fence: ExecutionFence) => void
  const active = new Promise<ExecutionFence>((resolve) => {
    activate = resolve
  })
  return {
    authority: {
      current: () =>
        kind === 'active'
          ? ({ kind: 'active', fence: { epoch: 1, token: 't' } } as const)
          : ({ kind: 'standby', reason: null } as const),
      whenActive: () => active,
    },
    activate: () => activate({ epoch: 2, token: 'lease' }),
  }
}

function recordingFactory(log: string[], fail = false): DaemonProviderRuntimeHandleFactory {
  return {
    id: 'worker',
    start() {
      if (fail) throw new Error('start failed')
      log.push('start')
      return { stop: () => void log.push('stop'), drain: () => void log.push('drain') }
    },
  }
}

const lifecycle = { operationId: 'op', provider: 'postgresql', generationId: 'g' } as never

test('a standalone authority keeps the background factory unchanged', () => {
  const factory = recordingFactory([])
  expect(startOnExecutionActive(controllableAuthority('active').authority, factory, () => {})).toBe(
    factory,
  )
})

test('a standby instance starts its background set on activation only', async () => {
  const log: string[] = []
  const gate = controllableAuthority('standby')
  const handle = await startOnExecutionActive(
    gate.authority,
    recordingFactory(log),
    () => {},
  ).start(lifecycle)
  await Promise.resolve()
  expect(log).toEqual([])
  gate.activate()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(log).toEqual(['start'])
  await handle.drain()
  await handle.stop()
  expect(log).toEqual(['start', 'drain', 'stop'])

  const never: string[] = []
  const stopped = controllableAuthority('standby')
  const waiting = await startOnExecutionActive(
    stopped.authority,
    recordingFactory(never),
    () => {},
  ).start(lifecycle)
  await waiting.stop()
  stopped.activate()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(never).toEqual([])

  const failures: unknown[] = []
  const failing = controllableAuthority('standby')
  await startOnExecutionActive(failing.authority, recordingFactory([], true), (error) =>
    failures.push(error),
  ).start(lifecycle)
  failing.activate()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(failures).toHaveLength(1)
})

test('exit requests made before the host subscribes are delivered once it does', () => {
  const exits = createExecutionExitRequests()
  const seen: string[] = []
  exits.request('execution-authority-frozen')
  exits.subscribe((reason) => seen.push(reason))
  exits.request('execution-activation-failed')
  expect(seen).toEqual(['execution-authority-frozen', 'execution-activation-failed'])
})

test('leaving execution authority drains and exits non-zero', async () => {
  const steps: string[] = []
  let requestExit!: (reason: string) => void
  let terminated!: (code: number) => void
  const exitCode = new Promise<number>((resolve) => {
    terminated = resolve
  })
  void runDaemonHostApplication({
    host: {
      readCurrent: () => null,
      publishReady: () => void steps.push('ready'),
      withdrawReady: () => void steps.push('withdraw'),
      subscribeShutdown: () => ({ close: () => void steps.push('control-closed') }),
      announceReady: () => {},
      terminate: (code) => {
        terminated(code)
        return new Promise<never>(() => {})
      },
    },
    databaseProvider: 'postgresql',
    readyInfo: () => ({ host: '0.0.0.0', port: 3000, url: 'http://x/', startedAt: 'now' }),
    readBootstrapRequired: () => false,
    readyBrowserUrl: () => 'http://x/',
    stopListener: () => void steps.push('listener'),
    stopApplication: () => void steps.push('application'),
    releaseAuthority: () => void steps.push('release'),
    releaseAuthorityOnExit: () => {},
    describeFailure: String,
    log: { info: () => {}, warn: () => {} },
    exitRequests: (request) => {
      requestExit = request
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  requestExit('execution-authority-frozen')
  expect(await exitCode).toBe(1)
  expect(steps).toEqual(expect.arrayContaining(['withdraw', 'listener', 'application', 'release']))
})

test('an exit request whose drain fails still exits non-zero', async () => {
  const warnings: string[] = []
  let requestExit!: (reason: string) => void
  let terminated!: (code: number) => void
  const exitCode = new Promise<number>((resolve) => {
    terminated = resolve
  })
  void runDaemonHostApplication({
    host: {
      readCurrent: () => null,
      publishReady: () => {},
      withdrawReady: () => {},
      subscribeShutdown: () => ({ close: () => {} }),
      announceReady: () => {},
      terminate: (code) => {
        terminated(code)
        return new Promise<never>(() => {})
      },
    },
    databaseProvider: 'postgresql',
    readyInfo: () => ({ host: '0.0.0.0', port: 3000, url: 'http://x/', startedAt: 'now' }),
    readBootstrapRequired: () => false,
    readyBrowserUrl: () => 'http://x/',
    stopListener: () => {},
    stopApplication: () => {},
    releaseAuthority: () => {
      throw new Error('lease release failed')
    },
    releaseAuthorityOnExit: () => {},
    describeFailure: String,
    log: { info: () => {}, warn: (message) => void warnings.push(message) },
    exitRequests: (request) => {
      requestExit = request
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  requestExit('execution-activation-failed')
  // The platform restarts the instance only after it exits.
  expect(await exitCode).toBe(1)
  expect(warnings).toContain('daemon exit request drain error')
})

// Regression (found by the local hosted smoke): the operation layer rethrows only
// declared public error categories, so an undeclared 503 surfaced as a 500
// operation contract violation instead of the hosted reason.
test('hosted refusals reach the caller as 503 through the operation contracts', async () => {
  // M2 implements plugin installation on CrewStation; the contract still
  // carries a declared 503 refusal (e.g. a capability the platform lacks).
  const refusal = new DomainError(
    'hosted-capability-unavailable',
    'not available on this CrewStation-hosted deployment',
    503,
    { capability: 'plugin-install' },
  )
  const plugins = createPluginOperationDescriptors(
    {
      create: async () => {
        throw refusal
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
  )
  await expect(
    invokeOperation(plugins.create, {} as never, { name: 'hosted-plugin', spec: 'plugin@1.0.0' }),
  ).rejects.toBe(refusal)
  for (const operation of [plugins.create, plugins.update, plugins.checkUpdate]) {
    expect(operation.publicErrors).toContain('unavailable')
  }
  const packages = createResourcePackageOperationDescriptors({} as never, {} as never)
  expect(packages.apply.publicErrors).toContain('unavailable')
})

test('a hosted page states its deployment; standalone pages are unchanged', async () => {
  const html = '<!doctype html><html><head><title>aw</title></head><body></body></html>'
  const asset = {
    body: new TextEncoder().encode(html).buffer as ArrayBuffer,
    contentType: 'text/html',
  }
  expect(withDeploymentMarker(asset, 'standalone')).toBe(asset)
  const hosted = new TextDecoder().decode(withDeploymentMarker(asset, 'crewstation').body)
  expect(hosted).toContain('<meta name="agent-workflow-deployment" content="crewstation"></head>')
  const lookup = async (path: string) =>
    path === 'index.html'
      ? asset
      : path === 'assets/app.js'
        ? { ...asset, contentType: 'text/javascript' }
        : null
  for (const path of ['/', '/tasks/1', '/index.html']) {
    const response = await getEmbeddedFrontendResponse(path, lookup, 'crewstation')
    expect(await response!.text()).toContain('agent-workflow-deployment')
  }
  const script = await getEmbeddedFrontendResponse('/assets/app.js', lookup, 'crewstation')
  expect(await script!.text()).not.toContain('agent-workflow-deployment')
  const standalone = await getEmbeddedFrontendResponse('/', lookup)
  expect(await standalone!.text()).toBe(html)
})

test('platform probes answer without execution authority', async () => {
  let fail = false
  const app = new Hono()
  mountHealthRoutes(
    app,
    { opencodeVersion: null, dbVersion: 1 },
    {
      snapshot: () => ({
        accessUpdate: { success: 0, noOp: 0, conflict: 0, rejected: 0 },
        authorityReresolution: 0,
        invalidStoredGrant: 0,
        wsTargetedRefreshFailure: 0,
      }),
    },
    {
      async countRunningTasks() {
        if (fail) throw new Error('database down')
        return 0
      },
    },
  )
  const live = await app.request('/live')
  expect(live.status).toBe(200)
  expect(await live.json()).toEqual({ alive: true })
  expect(await (await app.request('/ready')).json()).toEqual({ ready: true })
  fail = true
  const unready = await app.request('/ready')
  expect(unready.status).toBe(503)
  expect(await unready.json()).toEqual({ ready: false, reason: 'database-unavailable' })
  expect((await app.request('/live')).status).toBe(200)
})

test('the Manifest is rendered from a validated deployment profile', () => {
  const profile = parseDeploymentProfile({
    project: 'agent-workflow',
    repository: 'http://gitlab/aw/agent-workflow.git',
    branch: 'main',
    servicePlanId: '01a0bf5d-8f4b-7000-9e4b-b54e91ee9d10',
    secretKeyDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000001',
    adminSubjectsDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000002',
    agentProfilesDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000003',
    taskProfileId: '01a0bf5d-8f4b-7100-8000-000000000004',
    taskRuntimeImageVersionId: '01a0bf5d-8f4b-7100-8000-000000000005',
    objectStoragePlanId: '01a0bf5d-8f4b-7100-8000-000000000006',
    agentProfiles: [
      {
        id: '01a0bf5d-8f4b-7100-8000-000000000007',
        name: 'OpenCode',
        compute: { kind: 'profile', profileId: '01a0bf5d-8f4b-7100-8000-000000000008' },
      },
    ],
  })
  expect(
    renderCrewStationManifest(
      'plan: {{SERVICE_PLAN_ID}}\nkey: {{SECRET_KEY_DEFINITION_ID}}\nadmins: {{ADMIN_SUBJECTS_DEFINITION_ID}}\n',
      profile,
    ),
  ).toBe(
    'plan: 01a0bf5d-8f4b-7000-9e4b-b54e91ee9d10\nkey: 01a0bf5d-8f4b-7100-8000-000000000001\nadmins: 01a0bf5d-8f4b-7100-8000-000000000002\n',
  )
  expect(profile.agentProfiles[0]?.businessConfig.nativeConfig).toEqual({
    agentDefinitions: true,
    inlineRemoteMcp: true,
    inlineLocalMcp: true,
    plugins: true,
  })
  expect(renderCrewStationManifest('{ { AGENT_PROFILES_JSON } }', profile)).toBe(
    JSON.stringify(profile.agentProfiles),
  )
  const eventsProfile = parseDeploymentProfile({
    ...profile,
    eventSourcesDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000009',
    eventTypeIds: ['01a0bf5d-8f4b-7100-8000-000000000010'],
  })
  expect(
    parseYaml(
      renderCrewStationManifest('subscriptions: {{EVENT_SUBSCRIPTIONS_JSON}}', eventsProfile),
    ),
  ).toEqual({
    subscriptions: [
      {
        eventTypeId: eventsProfile.eventTypeIds![0],
        handlerPath: '/integrations/crewstation/events',
      },
    ],
  })
  expect(renderCrewStationManifest('{{ENV_JSON}}', eventsProfile)).toContain('AW_EVENT_SOURCES')
  expect(JSON.parse(renderCrewStationManifest('{{SERVICE_COMMAND_JSON}}', eventsProfile))).toEqual([
    '/usr/bin/env',
    `AW_EVENT_TYPE_IDS=${JSON.stringify(eventsProfile.eventTypeIds)}`,
    'agent-workflow',
    'start',
  ])
  // RFC-370 v3 V5: database restores come from the platform restore operation
  // (CS_DATABASE_RESTORE_REFERENCE); the release Job takes no AW restore input.
  expect(() =>
    parseDeploymentProfile({
      ...profile,
      restoreObjectDefinitionId: profile.adminSubjectsDefinitionId,
    }),
  ).toThrow('no longer supported')
  expect(renderCrewStationManifest('{{ENV_JSON}}', profile)).not.toContain('AW_RESTORE_OBJECT')
  // RFC-370 v3 V4: every hosted service declares the two parent-level recovery
  // actions; node retry/resume stay AW's own task commands, and a recovery
  // request acts as its requesting platform user (no service identity).
  expect(parseYaml(renderCrewStationManifest('{{RECOVERY_DECLARATION}}', profile))).toEqual({
    recovery: { actions: ['resume-task', 'rebuild-workspace'] },
  })
  expect(renderCrewStationManifest('{{ENV_JSON}}', profile)).not.toContain('AW_RECOVERY_IDENTITY')
  expect(() =>
    parseDeploymentProfile({
      ...profile,
      recoveryIdentityDefinitionId: profile.adminSubjectsDefinitionId,
    }),
  ).toThrow('no longer supported')
  const gitProfile = parseDeploymentProfile({
    ...profile,
    gitCredentialsDefinitionId: profile.adminSubjectsDefinitionId,
  })
  expect(JSON.parse(renderCrewStationManifest('{{ENV_JSON}}', gitProfile))).toContainEqual({
    name: 'AW_GIT_CREDENTIAL_BINDINGS',
    from: 'config',
    configDefinitionId: profile.adminSubjectsDefinitionId,
  })
  expect(gitProfile.agentProfiles[0]!.businessConfig.allowedEnvNames).toContain(
    'GIT_CONFIG_PARAMETERS',
  )
  expect(gitProfile.agentProfiles[0]!.businessConfig.allowedEnvNames).toContain('AW_GIT_AUTH_31')
  expect(gitProfile.agentProfiles[0]!.businessConfig.allowedEnvNames.length).toBeLessThanOrEqual(
    128,
  )
  expect(profile.agentProfiles[0]!.businessConfig.allowedEnvNames).toEqual([
    'GIT_CONFIG_PARAMETERS',
  ])
  expect(
    JSON.parse(renderCrewStationManifest('{{COMMAND_BUSINESS_CONFIG_JSON}}', gitProfile)),
  ).toEqual({
    allowedEnvNames: [
      'AW_GIT_CREDENTIAL_BINDINGS',
      ...Array.from({ length: 32 }, (_, index) => `AW_GIT_AUTH_${index}`),
    ],
  })
  expect(
    JSON.parse(renderCrewStationManifest('{{COMMAND_BUSINESS_CONFIG_JSON}}', profile)),
  ).toEqual({ allowedEnvNames: [] })
  expect(() =>
    parseDeploymentProfile({ ...profile, gitCredentialsDefinitionId: 'plaintext-token' }),
  ).toThrow('resource UUID')
  expect(() =>
    parseDeploymentProfile({ ...profile, restoreObjectDefinitionId: 'arbitrary-url' }),
  ).toThrow('restoreObjectDefinitionId')
  expect(() =>
    parseDeploymentProfile({ ...profile, eventTypeIds: eventsProfile.eventTypeIds }),
  ).toThrow('require both')
  expect(() => renderCrewStationManifest('{{UNKNOWN}}', profile)).toThrow(
    'unknown manifest placeholder',
  )
  expect(() => parseDeploymentProfile({ ...profile, servicePlanId: 'small' })).toThrow(
    'must be a resource UUID',
  )
  expect(() => parseDeploymentProfile({ ...profile, branch: '' })).toThrow(
    'profile.branch is required',
  )
})

test('the shipped Manifest template and image start the hosted control plane', () => {
  const root = new URL('../../../deploy/crewstation/', import.meta.url)
  const manifest = parseYaml(
    renderCrewStationManifest(
      readFileSync(new URL('crewstation.template.yaml', root), 'utf8'),
      parseDeploymentProfile({
        project: 'agent-workflow',
        repository: 'http://gitlab/aw/agent-workflow.git',
        branch: 'main',
        servicePlanId: '01a0bf5d-8f4b-7000-9e4b-b54e91ee9d10',
        secretKeyDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000001',
        adminSubjectsDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000002',
        agentProfilesDefinitionId: '01a0bf5d-8f4b-7100-8000-000000000003',
        taskProfileId: '01a0bf5d-8f4b-7100-8000-000000000004',
        taskRuntimeImageVersionId: '01a0bf5d-8f4b-7100-8000-000000000005',
        objectStoragePlanId: '01a0bf5d-8f4b-7100-8000-000000000006',
        agentProfiles: [
          {
            id: '01a0bf5d-8f4b-7100-8000-000000000007',
            name: 'OpenCode',
            compute: { kind: 'profile', profileId: '01a0bf5d-8f4b-7100-8000-000000000008' },
          },
        ],
      }),
    ),
  ) as {
    apiVersion: string
    kind: string
    spec: {
      service: {
        command: string[]
        port: number
        probes: Record<
          string,
          { path: string; periodSeconds: number; timeoutSeconds: number; failureThreshold: number }
        >
      }
      env: { name: string; from: string }[]
      release: { migrationCommand: string[] }
    }
  }
  expect(manifest).toMatchObject({ apiVersion: 'crewstation/v3', kind: 'DigitalWorker' })
  expect(manifest.spec.service.command).toEqual(['agent-workflow', 'start'])
  expect(manifest.spec.service.port).toBe(3000)
  expect(manifest.spec.service.probes.liveness!.path).toBe('/live')
  expect(manifest.spec.service.probes.readiness!.path).toBe('/ready')
  // CrewStation's probe contract (packages/contracts/manifest/serviceProbes.ts in the
  // CrewStation repository) bounds every probe; the first local publish was refused
  // for a startup failureThreshold of 150.
  for (const probe of Object.values(manifest.spec.service.probes)) {
    expect(probe.failureThreshold).toBeLessThanOrEqual(120)
    expect(probe.periodSeconds).toBeLessThanOrEqual(300)
    expect(probe.timeoutSeconds).toBeLessThanOrEqual(60)
  }
  // The startup budget still covers a cold boot on a small service plan.
  const startup = manifest.spec.service.probes.startup!
  expect(startup.periodSeconds * startup.failureThreshold).toBeGreaterThanOrEqual(300)
  expect(manifest.spec.release.migrationCommand).toEqual(['agent-workflow', 'migrate'])
  expect(manifest.spec.env).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'AW_SECRET_KEY', from: 'secret' }),
      expect.objectContaining({ name: 'AW_ADMIN_SUBJECTS', from: 'config' }),
    ]),
  )
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8')
  expect(dockerfile).toContain('AW_DEPLOYMENT_MODE=crewstation')
  expect(dockerfile).toContain('CMD ["agent-workflow", "start"]')
  expect(dockerfile).toMatch(/^USER agent-workflow$/m)
  expect(dockerfile).toContain('bun run build:binary')
  // A plain Bun image builds successfully but cannot join the CS session:
  // task images must keep the platform's digest-pinned Runner and entrypoint.
  const taskDockerfile = readFileSync(new URL('task.Dockerfile', root), 'utf8')
  expect(taskDockerfile).toMatch(/^ARG CS_BASE_IMAGE$/m)
  expect(taskDockerfile.match(/^FROM .+$/gm)?.at(-1)).toBe('FROM ${CS_BASE_IMAGE}')
  expect(taskDockerfile).not.toMatch(/^(ENTRYPOINT|CMD)\s/m)
  expect(taskDockerfile).toContain('/usr/local/bin/agent-workflow')
})
