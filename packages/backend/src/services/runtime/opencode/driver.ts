// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.

import type {
  BusinessNodeSpawnContext,
  InventoryReadContext,
  NormalizedEvent,
  ProbeOpts,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  SessionCaptureContext,
  SpawnPlan,
  SystemAgentSpawnContext,
  ListModelsOpts,
} from '../types'
import type { InventorySnapshot } from '@agent-workflow/shared'
import type { LivePollOptions, LivePollerHandle } from '@/services/subagentLiveCapture'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseEvent } from './events'
import { buildOpencodeSpawn } from './spawn'
import { buildInlineConfig } from './inlineConfig'
import { pickRuntimeHead } from '../head'
import { stageSkills } from '../stageSkills'
import { MIN_OPENCODE_VERSION, probeOpencode } from '@/util/opencode'
import { getOpencodeBinaryVersion } from '@/util/opencode-version-registry'
import { listOpencodeModels } from '@/util/opencode-models'
import { captureChildSessions } from '@/services/sessionCapture'
import { readSnapshotFromRunDir } from '@/services/inventory'
import { startLiveSubagentCapture } from '@/services/subagentLiveCapture'
import { materializeInventoryPlugin } from '@/opencode-plugin'
import { buildVerifiedOpencodeBusinessPlan, usesLegacyTestOpencodePath } from './verifiedPlan'
import { buildVerifiedOpencodeSystemPlan } from './verifiedSystemPlan'

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  minVersion: MIN_OPENCODE_VERSION,
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions
  // (byte-for-byte behavior); later PRs move call sites onto these.
  defaultBinary(config: RuntimeBinaryConfig): string[] {
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeOpencode(binary, opts)
  },
  async listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return listOpencodeModels(binary, opts)
  },
  async captureSessions(ctx: SessionCaptureContext): Promise<void> {
    await captureChildSessions({
      rootSessionId: ctx.rootSessionId,
      nodeRunId: ctx.nodeRunId,
      taskId: ctx.taskId,
      db: ctx.db,
      log: ctx.log,
      ...(ctx.alreadyInsertedPartIds !== undefined
        ? { alreadyInsertedPartIds: ctx.alreadyInsertedPartIds }
        : {}),
      ...(ctx.opencodeDbPath !== undefined ? { opencodeDbPath: ctx.opencodeDbPath } : {}),
    })
  },
  // RFC-117 — system-agent spawn. Minimal inline config (prompt + model only; no
  // skills/mcp/plugins/inventory, no RFC-029/041 in-place mutation), then the
  // shared buildOpencodeSpawn. opencode takes the prompt positionally → no stdin.
  async buildSpawn(ctx: SystemAgentSpawnContext): Promise<SpawnPlan> {
    const envBin = process.env.AGENT_WORKFLOW_OPENCODE_BIN
    const head =
      ctx.runtimeBinary != null && ctx.runtimeBinary !== ''
        ? [ctx.runtimeBinary]
        : envBin != null && envBin !== ''
          ? [envBin]
          : ['opencode']
    if (ctx.testOnlyUnverifiedRuntime !== true) {
      return buildVerifiedOpencodeSystemPlan(ctx, head)
    }
    const inlineConfig = {
      agent: {
        [ctx.agentName]: {
          prompt: ctx.systemPrompt,
          ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
        },
      },
    }
    // RFC-143 PR-4: the AGENT_WORKFLOW_OPENCODE_BIN env override (previously a
    // `protocol === 'opencode'` branch in memoryDistiller) is internalized here:
    // a system-agent run with NO explicit binary falls back to it before the
    // built-in `opencode` head. Callers that pass a binary (smoke probes, custom
    // forks) are unaffected. claude has no analogous override.
    const { cmd, env } = buildOpencodeSpawn({
      opencodeCmd: head,
      // 2026-07-21: legacy/test-only flag-spelling gate. RFC-226 removed boot
      // prewarming; explicit doctor/status probes may seed this registry, while
      // RFC-224 production uses the pinned direct API above.
      binaryVersion: getOpencodeBinaryVersion(head[0] ?? 'opencode'),
      agentName: ctx.agentName,
      prompt: ctx.prompt,
      worktreePath: ctx.worktreePath,
      runDir: ctx.runDir,
      inlineConfigSerialized: JSON.stringify(inlineConfig),
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
    })
    return { cmd, env, stdin: { mode: 'ignore' } }
  },
  // RFC-143 PR-4 — business-node spawn: the ENTIRE opencode assembly the runner
  // used to do inline (runner.ts:491-905 pre-collapse), moved VERBATIM so the
  // inputs to buildOpencodeSpawn stay byte-for-byte identical (golden lock):
  // inline-config build → RFC-029 inventory plugin append → RFC-041 memory
  // block append → serialize → spawn. async for materializeInventoryPlugin.
  async buildBusinessSpawn(ctx: BusinessNodeSpawnContext): Promise<SpawnPlan> {
    const businessHead = pickRuntimeHead(ctx.runtimeBinary, ctx.opencodeCmd)
    if (!usesLegacyTestOpencodePath(ctx)) {
      return buildVerifiedOpencodeBusinessPlan(ctx, businessHead ?? ['opencode'])
    }
    // RFC-154: stage framework skills into THIS runtime's config dir (leaf name
    // from the frozen profile; was the runner's runtime-blind `.opencode`
    // preamble). Strict mode: a staging failure fails the spawn (runner §6 maps
    // the throw to runtime-spawn-failed) — a silently missing skill is worse.
    const runDir = join(ctx.runRoot, ctx.configDir.name)
    stageSkills(runDir, ctx.skills, ctx.log)

    // RFC-022/028/031: primary + closure dependents + mcp + plugin entries.
    const inlineConfig = buildInlineConfig(
      ctx.agent,
      ctx.resolvedParamsByAgent,
      ctx.dependents,
      ctx.mcps,
      ctx.plugins,
    )

    // RFC-029: wire the inventory dump plugin (business gate — agent kind +
    // not a followup — is precomputed by the runner as `wantsInventory`; that
    // opencode is the runtime that HAS this capability is embodied right here).
    let inventoryOutPath: string | undefined
    if (ctx.wantsInventory) {
      try {
        mkdirSync(ctx.runRoot, { recursive: true })
        // materializeInventoryPlugin handles both dev (source tree) and
        // single-binary (embed table) layouts — see opencode-plugin/index.ts.
        const pluginPath = await materializeInventoryPlugin(ctx.runRoot)
        const fileSpec: string | [string, Record<string, unknown>] = `file://${pluginPath}`
        inlineConfig.plugin = [...(inlineConfig.plugin ?? []), fileSpec]
        inventoryOutPath = join(ctx.runRoot, 'inventory.json')
      } catch (err) {
        // Non-fatal: if we can't materialize the plugin (disk full / permission
        // denied / asset missing in binary mode), the run continues without
        // inventory capture and the post-exit read lands on `plugin-load-failed`.
        ctx.log.warn('inventory-plugin-materialize-failed', {
          nodeRunId: ctx.nodeRunId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // RFC-041: weave the injected memory block into the primary agent's inline
    // prompt (the runner resolved the block; HOW it reaches the model is ours).
    if (ctx.injectedMemoryBlock !== null) {
      const primary = inlineConfig.agent[ctx.agent.name]
      if (primary !== undefined && typeof primary.prompt === 'string') {
        primary.prompt = `${primary.prompt}\n\n${ctx.injectedMemoryBlock}`
      }
    }

    // RFC-022 §design B6: warn (don't fail) when the serialized config crosses
    // the soft cap. Real OS env-var ceilings are well above this; the warning
    // helps catch authors stuffing massive bodies into every dependent agent
    // OR cramming many MCP servers' env / headers maps.
    const serializedInline = JSON.stringify(inlineConfig)
    if (serializedInline.length > 32 * 1024) {
      ctx.log.warn('inline-config-large', {
        bytes: serializedInline.length,
        agents: Object.keys(inlineConfig.agent),
        mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
      })
    }

    // RFC-112: a custom opencode fork's binary wins; else the RFC-111 head
    // (production config.opencodePath via resolveOpencodeCmd, or a test mock)
    // — byte-for-byte unchanged for built-ins.
    const { cmd, env } = buildOpencodeSpawn({
      opencodeCmd: businessHead,
      // 2026-07-21: legacy/test-only flag-spelling gate (see buildSpawn above).
      // Key = head[0] exactly as spawned and as explicit probes record it.
      binaryVersion: getOpencodeBinaryVersion(businessHead?.[0] ?? 'opencode'),
      agentName: ctx.agent.name,
      prompt: ctx.prompt,
      resumeSessionId: ctx.resumeSessionId,
      worktreePath: ctx.worktreePath,
      runDir,
      configDirEnv: ctx.configDir.env, // RFC-154: frozen env-var name
      inlineConfigSerialized: serializedInline,
      inventoryOutPath,
      gitUserName: ctx.gitUserName,
      gitUserEmail: ctx.gitUserEmail,
    })
    // §4.4: what actually landed in the inline JSON, for the runner's
    // `spawning agent runtime` diagnostic line (same fields it used to derive).
    const primaryInline = inlineConfig.agent[ctx.agent.name] as Record<string, unknown> | undefined
    return {
      cmd,
      env,
      diagnostics: {
        inlineModel: primaryInline?.model ?? null,
        inlineVariant: primaryInline?.variant ?? null,
        inlineTemperature: primaryInline?.temperature ?? null,
        mcpCount: inlineConfig.mcp ? Object.keys(inlineConfig.mcp).length : 0,
        mcpKeys: inlineConfig.mcp ? Object.keys(inlineConfig.mcp) : [],
        pluginCount: ctx.plugins.filter((p) => p.enabled !== false).length,
        pluginNames: ctx.plugins.filter((p) => p.enabled !== false).map((p) => p.name),
      },
    }
  },
  // —— optional capabilities (opencode implements; claude omits) ——
  async readInventory(ctx: InventoryReadContext): Promise<InventorySnapshot | null> {
    return readSnapshotFromRunDir({
      runDir: ctx.runRoot,
      nodeKind: ctx.nodeKind,
      pureMode:
        ctx.verifiedIdentity === true
          ? false
          : process.env.OPENCODE_PURE === '1' || process.env.OPENCODE_PURE === 'true',
    })
  },
  startLiveCapture(ctx: LivePollOptions): LivePollerHandle {
    return startLiveSubagentCapture(ctx)
  },
}
