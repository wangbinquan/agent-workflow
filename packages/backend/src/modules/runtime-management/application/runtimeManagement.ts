// RFC-360: management behavior lives in one application, shared by every database provider.
import { ConflictError, NotFoundError } from '@/util/errors'
import { redactSensitiveString } from '@/util/redact'
import {
  parseRuntimeExtraArgs,
  runtimeProbeTargetOf,
  runtimeRowToView,
} from '../domain/runtimeProfile'
import type { RuntimeDiagnosticCommands, RuntimeProfileCommands } from '../public/commands'
import type { RuntimeModelQueries, RuntimeProfileQueries } from '../public/queries'
import type { RuntimeManagementDependencies } from './ports/runtimeManagement'
import type { RuntimeRow } from '../domain/runtimeProfile'

export interface RuntimeManagementApplication {
  readonly profiles: RuntimeProfileCommands
  readonly queries: RuntimeProfileQueries
  readonly diagnostics: RuntimeDiagnosticCommands
  readonly models: RuntimeModelQueries
}

export function createRuntimeManagement(
  deps: RuntimeManagementDependencies,
): RuntimeManagementApplication {
  const { registry, config, drivers, modelDiscovery, tests } = deps
  const smokeRuntime: typeof drivers.smoke = (input) => drivers.smoke(input)
  const assertRuntimeSpawnCapabilities: typeof drivers.assertSpawnCapabilities = (
    protocol,
    input,
  ) => drivers.assertSpawnCapabilities(protocol, input)
  const view = async (row: RuntimeRow) => {
    const cfg = await config.current()
    return runtimeRowToView(row, cfg.defaultRuntime, drivers.resolveTarget(row, cfg).receiptKey)
  }
  const staleProbe = (name: string): never => {
    throw new ConflictError(
      'runtime-probe-stale',
      `runtime '${name}' changed while its probe was running; retry the probe`,
    )
  }

  const profiles: RuntimeProfileCommands = {
    async create(input) {
      let smoke
      const wantProbe = input.probe ?? input.binaryPath !== undefined
      if (wantProbe && input.binaryPath !== undefined && input.binaryPath !== null) {
        // The inbound schema has already decoded the protocol; retain validation order before the effect.
        const protocol = input.protocol
        assertRuntimeSpawnCapabilities(protocol, input)
        const cfg = await config.current()
        smoke = await smokeRuntime({
          protocol,
          target: drivers.capture({ protocol: () => protocol, binaryPath: input.binaryPath }),
          config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
          ...(typeof input.model === 'string' ? { model: input.model } : {}),
          isSandbox: input.isSandbox === true,
          ...(Array.isArray(input.extraArgs) && input.extraArgs.length > 0
            ? { extraArgs: input.extraArgs }
            : {}),
        })
      }
      let row = await registry.createRuntime({ ...input, binaryPath: input.binaryPath ?? null })
      const cfg = await config.current()
      if (smoke !== undefined) {
        const target = runtimeProbeTargetOf(row, drivers.resolveTarget(row, cfg).receiptKey)
        await registry.cacheRuntimeProbe(target, smoke)
        const refreshed = await registry.getRuntime(row.name)
        if (refreshed?.id === row.id) row = refreshed
      }
      return {
        runtime: runtimeRowToView(
          row,
          cfg.defaultRuntime,
          drivers.resolveTarget(row, cfg).receiptKey,
        ),
        ...(smoke !== undefined ? { smoke } : {}),
      }
    },
    async update(name, input) {
      const row = await registry.updateRuntime(name, input)
      await tests.reconcile()
      return { runtime: await view(row) }
    },
    async setEnabled(name, enabled) {
      const cfg = await config.current()
      const row = await registry.setRuntimeEnabled(name, enabled, cfg.defaultRuntime)
      await tests.reconcile()
      return {
        runtime: runtimeRowToView(
          row,
          cfg.defaultRuntime,
          drivers.resolveTarget(row, cfg).receiptKey,
        ),
      }
    },
    async remove(name) {
      const cfg = await config.current()
      await registry.deleteRuntime(name, {
        defaultRuntime: cfg.defaultRuntime,
        memoryDistillRuntime: cfg.memoryDistillRuntime,
        commitPushRuntime: cfg.commitPushRuntime,
        mergeAgentRuntime: cfg.mergeAgentRuntime,
        intentBuilderRuntime: cfg.intentBuilderRuntime,
        changeNarrativeRuntime: cfg.changeNarrativeRuntime,
      })
      await tests.reconcile()
      return { ok: true }
    },
  }

  const queries: RuntimeProfileQueries = {
    async list() {
      const rows = await registry.listRuntimes()
      const cfg = await config.current()
      return {
        runtimes: rows.map((row) => ({
          ...runtimeRowToView(row, cfg.defaultRuntime, drivers.resolveTarget(row, cfg).receiptKey),
          capabilities: { mcpRuntimeTestV1: tests.eligible(row) },
        })),
      }
    },
    async status() {
      const cfg = await config.current()
      const rows = (await registry.listRuntimes()).filter((row) => row.enabled)
      const configured = cfg.defaultRuntime ?? 'opencode'
      const defaultName = rows.some((row) => row.name === configured) ? configured : 'opencode'
      return {
        runtimes: await Promise.all(
          rows.map(async (row) => {
            const target = drivers.resolveTarget(row, cfg)
            const probe = await drivers.probeStatus(row.protocol, target, deps.statusProbeTimeoutMs)
            const state =
              probe.ran === true
                ? probe.compatible
                  ? ('ready' as const)
                  : ('protocol-incompatible' as const)
                : ('not-found' as const)
            return {
              name: row.name,
              protocol: row.protocol,
              binary: probe.binary,
              ok: state === 'ready',
              version: probe.version,
              reportedVersion: probe.version,
              state,
              isDefault: row.name === defaultName,
            }
          }),
        ),
      }
    },
  }

  const diagnostics: RuntimeDiagnosticCommands = {
    async probe(input) {
      if (input.kind === 'unsaved') {
        assertRuntimeSpawnCapabilities(input.protocol, input)
        const cfg = await config.current()
        const smoke = await smokeRuntime({
          protocol: input.protocol,
          target: drivers.capture({ protocol: () => input.protocol, binaryPath: input.binaryPath }),
          config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
          ...(input.model !== undefined ? { model: input.model } : {}),
          isSandbox: input.isSandbox === true,
          ...(input.extraArgs !== undefined && input.extraArgs.length > 0
            ? { extraArgs: input.extraArgs }
            : {}),
        })
        return { smoke }
      }
      const { name } = input
      const row = await registry.getRuntime(name)
      if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
      const cfg = await config.current()
      const diagnosticTarget = drivers.resolveTarget(row, cfg)
      const target = runtimeProbeTargetOf(row, diagnosticTarget.receiptKey)
      const extraArgs = parseRuntimeExtraArgs(row.extraArgsJson)
      assertRuntimeSpawnCapabilities(row.protocol, { extraArgs, isSandbox: row.isSandbox })
      const smoke = await smokeRuntime({
        protocol: row.protocol,
        runtimeObservationIdentity: {
          registrationId: row.id,
          configurationRevision: row.probeFence,
          acceptedName: row.name,
        },
        target: diagnosticTarget,
        config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
        ...(row.model !== null ? { model: row.model } : {}),
        isSandbox: row.isSandbox,
        ...(extraArgs !== null ? { extraArgs } : {}),
      })
      return config.withProbeReceiptFence(async () => {
        const current = await registry.getRuntime(name)
        if (
          current === null ||
          drivers.resolveTarget(current, await config.current()).receiptKey !==
            target.resolvedBinaryPath
        ) {
          staleProbe(name)
        }
        await deps.beforeProbeReceipt()
        if (!(await registry.cacheRuntimeProbe(target, smoke))) staleProbe(name)
        return { smoke }
      })
    },
  }

  const models: RuntimeModelQueries = {
    async list(input) {
      const cfg = await config.current()
      const rtParam = input.runtime
      const resolved =
        rtParam !== undefined && rtParam.length > 0
          ? await registry.resolveRuntimeByName(rtParam)
          : null
      const matchedReal = resolved !== null && resolved.name === rtParam
      const protocol = matchedReal
        ? resolved.protocol
        : rtParam === 'claude' || rtParam === 'claude-code'
          ? 'claude-code'
          : 'opencode'
      const target = modelDiscovery.resolveTarget(
        protocol,
        matchedReal ? resolved.binaryPath : null,
        cfg,
      )
      try {
        const listed = await modelDiscovery.list(protocol, target, input.refresh)
        return { kind: 'listed', models: { ...listed, binary: target.label } }
      } catch (error) {
        return {
          kind: 'unavailable',
          error: {
            ok: false,
            code: 'opencode-models-failed',
            message: redactSensitiveString((error as Error).message),
            runtime: rtParam ?? null,
          },
        }
      }
    },
  }

  return Object.freeze({
    profiles: Object.freeze(profiles),
    queries: Object.freeze(queries),
    diagnostics: Object.freeze(diagnostics),
    models: Object.freeze(models),
  })
}
