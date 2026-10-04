import { normalizeUsage } from './usage'
// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is NO LONGER runtime-branched in runNode: since
// RFC-282 B1 the single contract entry is `buildSpawn(AgentSpawnContext)` on
// this object; ./spawn.ts keeps the claude argv/env primitives it delegates to.
// (2026-08-12 审计对账：原注释仍描述 RFC-282 之前「装配在 runNode 里按 runtime
// 分支」的旧结构，已修正。)
import type {
  NormalizedEvent,
  ProbeOpts,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  ListModelsOpts,
} from '../types'
import { randomUUID } from 'node:crypto'
import { parseEvent, observeSystemEvent, parseResultError } from './events'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { claudeLocalAgentMaterial } from '@/modules/runtime-management/infrastructure/local/claudeAgentMaterial'
export {
  renderClaudeInjection,
  assembleClaudePersonaSpawn,
  assembleClaudeBusinessSpawn,
} from '@/modules/runtime-management/infrastructure/local/claudeAgentMaterial'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  // RFC-282 A3 — static declaration, values copied from today's behavior:
  // init event fires on EVERY run (followups included); faces per
  // renderInjection below (plugins have no claude face ⇒ unsupported;
  // tools/droppedParams are real declared+observed faces here).
  capabilities: {
    startupObservation: 'init-event',
    observationRequiresFreshRun: false,
    declarationFaces: {
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unsupported',
      tools: 'supported',
      droppedParams: 'supported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    },
    // RFC-297 T5 — the `system/init` event enumerates four faces by NAME only
    // (measured on claude 2.1.226): tools / agents / skills / mcp_servers. It
    // reports no mode, model, path, description, type or source, so those
    // fields are `unsupported` here and the unified read end drops the columns
    // instead of rendering a row of blanks. `plugins` is unsupported at the
    // face level — claude has no plugin concept at all (matches
    // `declarationFaces.plugins` above), so the whole block is omitted rather
    // than shown as "0 plugins".
    inventory: {
      agents: {
        support: 'supported',
        fields: { mode: 'unsupported', model: 'unsupported', source: 'unsupported' },
      },
      skills: {
        support: 'supported',
        fields: { source: 'unsupported', path: 'unsupported', description: 'unsupported' },
      },
      mcps: {
        support: 'supported',
        fields: { status: 'supported', type: 'unsupported', hint: 'unsupported' },
      },
      plugins: { support: 'unsupported', fields: { source: 'unsupported' } },
      tools: { support: 'supported', fields: {} },
    },
  },
  // 2026-08-04 — claude forks carry private flags (CodeAgent's
  // --skip-safe-check); the registry-validated extraArgs land at the argv tail.
  acceptsExtraArgs: true,
  // Claude CLI compatibility only; this capability does not provide platform
  // process isolation or any operating-system sandbox guarantee.
  acceptsSandboxCompatibilityMarker: true,
  // Advisory official-distribution baseline only. probe() is version-neutral
  // because compatible forks such as CodeAgent may use an opaque version scheme.
  minVersion: MIN_CLAUDE_CODE_VERSION,
  // RFC-280 T6 — playground session strategy (claude: pre-allocated UUID on
  // turn 1 via --session-id, resume thereafter).
  createMcpTestNativeSessionId: randomUUID,
  mcpTestSessionReference: ({ turnSeq, nativeSessionId }) => {
    if (nativeSessionId === null) throw new Error('mcp-test-native-session-missing')
    return turnSeq === 1 ? { nativeSessionId } : { resumeSessionId: nativeSessionId }
  },
  /**
   * RFC-284 T15（D10）—— claude 的 resume-不存在措辞，**实测采样**（本机
   * claude CLI，2026-08-12，两种失败形态各采一条，非猜测）：
   *   1) 合法格式未知 id：`No conversation found with session ID: <id>`
   *   2) 非法格式：`--resume requires a valid session ID … is not a UUID and
   *      does not match any session title`
   * 猜错方向安全：漏配只丢告警、不误报（调用方 ?? false）。措辞漂移时在此扩列。
   */
  detectSessionNotFound(stderrTail: string): boolean {
    if (stderrTail.length === 0) return false
    return (
      /no conversation found with session id/i.test(stderrTail) ||
      /is not a uuid and does not match any session title/i.test(stderrTail)
    )
  },
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  normalizeUsage,
  prepareSpanCapture: claudeLocalAgentMaterial.prepareSpanCapture,
  observeSystemEvent,
  // RFC-237 (design-gate P2-4) — surface a clean-exit terminal `is_error`
  // result (auth/API failure) so systemAgentRun can fail the run instead of
  // letting it masquerade as a missing envelope.
  parseTerminalResultError(line: string): string | null {
    const parsed = parseResultError(line)
    if (parsed === null || !parsed.isError) return null
    return parsed.message.length > 0 ? parsed.message : 'claude reported a terminal error result'
  },
  /**
   * RFC-297 T15 —— 启动自检拿它核对 `startupObservation: 'init-event'` 的声明。
   * 形状取自实测（claude 2.1.226 的 `system/init`），四个面各留一项即可——
   * 自检只问「解析得出载荷吗」，不问内容多少。
   */
  initEventSample(): string {
    return JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'self-check',
      tools: ['Read'],
      agents: ['general-purpose'],
      skills: [],
      mcp_servers: [],
    })
  },
  // RFC-297 T11 —— 原先这里有两个方法（parseUnusableMcpServers /
  // parseStartupInventory）各自把同一行 init 再解析一遍。清单现在由 parseEvent
  // 在那一次解析里挂进 data.inventory：MCP 可用性、工具集、子代理、技能四个面
  // 同源，消费方只读载荷。Claude 在 init 处冻结 MCP 可用性的语义未变——
  // 非 `connected` 的服务器整轮都拿不到工具，判定移到消费侧同一份观测上做。
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions.
  defaultBinary(config: RuntimeBinaryConfig): string[] {
    return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeClaudeCode(binary, opts)
  },
  // claude has no `models` subcommand — a static table, ignores binary, always
  // cached. RFC-143: the provider/modelID defaults (was in routes/runtime.ts's
  // isClaude branch) live here now so the route emits one shape for both runtimes.
  async listModels(binary: string, _opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return {
      binary,
      models: listClaudeModels().map((m) => ({
        id: m.id,
        provider: m.provider ?? 'anthropic',
        modelID: m.modelID ?? m.id,
        name: m.name,
      })),
      cached: true,
    }
  },
  captureSessions: claudeLocalAgentMaterial.captureSessions,
  // RFC-143 PR-4 — business-node spawn (was the claude branch of runner.ts:828).
  // system-prompt-file (persona + RFC-041 memory weave) + RFC-111 PR-C MCP /
  // dependsOn-subagent flags + the credential-bridge DECISION (internalized:
  // presence of the test-only head override is the mock signal — production
  // never sets it, so real runs bridge; CI never touches the keychain). No
  // internal awaits — async only to match the interface (§4.6B).
  // RFC-282 B1a — unified assembly facade (see the opencode twin for the
  // contract; parity suite rfc282-b1a is live while both paths exist).
  buildSpawn: claudeLocalAgentMaterial.buildSpawn,
}
