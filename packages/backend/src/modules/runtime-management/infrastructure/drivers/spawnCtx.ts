// RFC-282 B1a — AgentSpawnContext → legacy-context translation, shared by both
// drivers' unified `buildSpawn` facade.
//
// The facade keeps byte-for-byte parity with the legacy paths (§0 首要原则):
// business calls (taskMounts present) translate onto `buildBusinessSpawn`'s
// assembly; persona-only calls (taskMounts omitted — system faces carry no
// boundary in v1) translate onto the legacy system `buildSpawn` assembly.
// B1b migrates callers onto the facade and deletes the legacy shapes; deeper
// single-path assembly (§7-1a's unified system-face output) is deferred until
// the duplicate internals converge (B4) so the facade itself changes ZERO
// bytes of any spawn.

import type { Agent } from '@agent-workflow/shared'
import type {
  AgentSpawnContext,
  BusinessNodeSpawnContext,
  RenderedInjectionV1,
  SystemAgentSpawnContext,
} from './types'

/** persona-only spawns synthesize the same minimal agent shape the legacy
 *  system path fed `renderOpencodeAgentEntry` (driver.ts): name + persona
 *  body, empty permission, no outputs. */
export function syntheticPersonaAgent(ctx: AgentSpawnContext): Agent {
  return {
    name: ctx.agentName,
    description: '',
    bodyMd: ctx.systemPrompt,
    permission: {},
    outputs: [],
  } as unknown as Agent
}

/** Business translation. `binaryOverride` lands on the per-driver legacy knob
 *  the assembly actually reads (opencode: `opencodeCmd`; claude: `runtimeCmd`
 *  — both carry the same "test head + credential-bridge-off" semantics). */
export function toBusinessCtx(
  ctx: AgentSpawnContext,
  head: { opencodeCmd?: string[] } | { runtimeCmd?: string[] },
): BusinessNodeSpawnContext {
  if (ctx.taskMounts === undefined) {
    throw new Error('toBusinessCtx requires taskMounts (persona-only spawns take the system path)')
  }
  if (ctx.configDir === undefined) {
    throw new Error('toBusinessCtx requires configDir (the runner always threads a profile)')
  }
  return {
    agent: ctx.injection.agent ?? syntheticPersonaAgent(ctx),
    prompt: ctx.prompt,
    injectedMemoryBlock: ctx.injectedMemoryBlock ?? null,
    dependents: ctx.injection.dependents ?? [],
    mcps: ctx.injection.mcps,
    plugins: ctx.injection.plugins ?? [],
    resolvedParamsByAgent: ctx.resolvedParamsByAgent,
    skills: ctx.injection.skills ?? [],
    worktreePath: ctx.cwd,
    taskMounts: ctx.taskMounts,
    runRoot: ctx.runRoot,
    configDir: ctx.configDir,
    freshAgentRun: ctx.freshAgentRun,
    nodeRunId: ctx.nodeRunId,
    log: ctx.log,
    ...(ctx.resumeSessionId != null ? { resumeSessionId: ctx.resumeSessionId } : {}),
    ...(ctx.boundaryHostProbe !== undefined ? { boundaryHostProbe: ctx.boundaryHostProbe } : {}),
    ...(ctx.gitUserName !== undefined ? { gitUserName: ctx.gitUserName } : {}),
    ...(ctx.gitUserEmail !== undefined ? { gitUserEmail: ctx.gitUserEmail } : {}),
    ...(ctx.runtimeBinary !== undefined ? { runtimeBinary: ctx.runtimeBinary } : {}),
    ...head,
  }
}

/** System translation (persona-only). Profile scalars come from the root
 *  entry of `resolvedParamsByAgent` — the unified ctx has no singular profile
 *  field by design (P1-1). */
export function toSystemCtx(
  ctx: AgentSpawnContext,
  rendered: RenderedInjectionV1,
  head: { opencodeCmd?: readonly string[] } | { runtimeCmd?: string[] },
): SystemAgentSpawnContext {
  const profile = ctx.resolvedParamsByAgent.get(ctx.agentName)
  return {
    agentName: ctx.agentName,
    systemPrompt: ctx.systemPrompt,
    prompt: ctx.prompt,
    worktreePath: ctx.cwd,
    runDir: ctx.runRoot,
    model: profile?.model ?? null,
    variant: profile?.variant ?? null,
    temperature: profile?.temperature ?? null,
    steps: profile?.steps ?? null,
    maxSteps: profile?.maxSteps ?? null,
    ...(profile?.isSandbox === true ? { isSandbox: true } : {}),
    ...(ctx.extraArgs !== undefined ? { extraArgs: ctx.extraArgs } : {}),
    ...(ctx.injection.mcps.length > 0 ? { mcpInjection: rendered } : {}),
    ...(ctx.freshAgentRun ? { freshAgentRun: true } : {}),
    ...(ctx.nativeSessionId != null ? { nativeSessionId: ctx.nativeSessionId } : {}),
    ...(ctx.resumeSessionId != null ? { resumeSessionId: ctx.resumeSessionId } : {}),
    ...(ctx.runtimeBinary != null ? { runtimeBinary: ctx.runtimeBinary } : {}),
    ...(ctx.gitUserName !== undefined ? { gitUserName: ctx.gitUserName } : {}),
    ...(ctx.gitUserEmail !== undefined ? { gitUserEmail: ctx.gitUserEmail } : {}),
    ...(ctx.configDir !== undefined
      ? { configDirEnv: ctx.configDir.env, configDirName: ctx.configDir.name }
      : {}),
    log: ctx.log,
    ...head,
  }
}
