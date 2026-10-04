import { normalizeUsage } from './usage'
// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.
import type {
  NormalizedEvent,
  ProbeOpts,
  RuntimeBinaryConfig,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  ListModelsOpts,
} from '../types'
import { observeSystemEvent, parseEvent } from './events'
import { detectOpencodeSessionNotFound, probeOpencode } from './util'
import { evictOpencodeModelsCache, listOpencodeModelsNatural } from './models'
import { opencodeLocalAgentMaterial } from '@/modules/runtime-management/infrastructure/local/opencodeAgentMaterial'
export {
  renderOpencodeInjection,
  assembleOpencodePersonaSpawn,
  assembleOpencodeBusinessSpawn,
} from '@/modules/runtime-management/infrastructure/local/opencodeAgentMaterial'

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  // RFC-282 A3 — static declaration, values copied from today's behavior:
  // inventory file written by the dump plugin per FRESH run (followups have
  // nothing to read — RFC-280 实现门 P2-E), faces per renderInjection below
  // (plugins injected but key-domain-mismatched ⇒ unobservable; tools/
  // droppedParams never produced ⇒ unsupported).
  capabilities: {
    startupObservation: 'inventory-file',
    observationRequiresFreshRun: true,
    declarationFaces: {
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unobservable',
      tools: 'unsupported',
      droppedParams: 'unsupported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    },
    // RFC-297 T5 — what the dump plugin's snapshot actually carries per face.
    // Fields mirror `InventorySnapshotCaptured` (shared/inventory.ts) 1:1, so
    // nothing opencode reports today is dropped by the unified read end.
    // `tools` is the one face opencode has no observation for — the plugin
    // does not enumerate the loaded tool set.
    inventory: {
      agents: {
        support: 'supported',
        fields: { mode: 'supported', model: 'supported', source: 'supported' },
      },
      skills: {
        support: 'supported',
        fields: { source: 'supported', path: 'supported', description: 'supported' },
      },
      mcps: {
        support: 'supported',
        fields: { status: 'supported', type: 'supported', hint: 'supported' },
      },
      plugins: { support: 'supported', fields: { source: 'supported' } },
      tools: { support: 'unsupported', fields: {} },
    },
  },
  minVersion: null,
  prepareSpanCapture: opencodeLocalAgentMaterial.prepareSpanCapture,
  // RFC-280 T6 — playground session strategy (opencode: no pre-allocated id;
  // resume rides the captured session id).
  createMcpTestNativeSessionId: () => null,
  mcpTestSessionReference: ({ nativeSessionId }) =>
    nativeSessionId === null ? {} : { resumeSessionId: nativeSessionId },
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  normalizeUsage,
  prepareUsageNormalizer: opencodeLocalAgentMaterial.prepareUsageNormalizer,
  prepareNativeUsageCapture: opencodeLocalAgentMaterial.prepareNativeUsageCapture,
  observeSystemEvent,
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions
  // (byte-for-byte behavior); later PRs move call sites onto these.
  defaultBinary(config: RuntimeBinaryConfig): string[] {
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeOpencode(binary, opts)
  },
  // RFC-276: model discovery uses the registered binary in the operator's
  // natural cwd/environment and therefore sees the same providers and auth as
  // an ordinary OpenCode invocation.
  async listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return listOpencodeModelsNatural(binary, opts)
  },
  // RFC-284 T19 — registry 在 runtime 删除/换二进制时对全部 driver 盲调；
  // opencode 的进程内缓存只有 models 列表这一份。
  evictBinaryCaches(binaryPath: string): void {
    evictOpencodeModelsCache(binaryPath)
  },
  detectSessionNotFound(stderrTail: string): boolean {
    return detectOpencodeSessionNotFound(stderrTail)
  },
  captureSessions: opencodeLocalAgentMaterial.captureSessions,
  // RFC-282 B1a — the unified assembly facade: ONE call returns plan +
  // declared manifest (declaration is a by-product of assembly, 决策 2/9).
  // Byte parity with the legacy paths is the contract; the parity suite
  // (rfc282-b1a) is live while both paths exist.
  buildSpawn: opencodeLocalAgentMaterial.buildSpawn,
  // —— optional capabilities (opencode implements; claude omits) ——
  readInventory: opencodeLocalAgentMaterial.readInventory,
  /**
   * RFC-297 T8 —— opencode 的清单不在 stdout 流里，而在子进程退出后的 dump 文件
   * 里。这里把它读出来**补发成一个普通事件**，于是下游 stage 无从分辨某份观测
   * 是来自流内一行还是来自一个文件——这正是「event 来源统一」的落点。
   *
   * 两道业务门在此，不再由调用方传布尔值进来（`freshAgentRun` 的老路）：
   *  · 复用了既有会话的 followup 里，dump 插件根本没重跑，读它只会得到上一轮的
   *    陈旧文件或一个 file-missing 桩；
   *  · 非 agent 节点压根不注入插件。
   * 「本运行时的观测何时可能存在」本来就只有它自己知道。
   */
  drainFinalEvents: opencodeLocalAgentMaterial.drainFinalEvents,
  startLiveCapture: opencodeLocalAgentMaterial.startLiveCapture,
  // RFC-237 — post-exit child-session sweep for SYSTEM agents (moved verbatim
  // from the `driver.kind === 'opencode'` branch in systemAgentRun.ts).
  captureSessionsToSink: opencodeLocalAgentMaterial.captureSessionsToSink,
}
