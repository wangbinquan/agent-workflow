// RFC-310 PR-9 —— cutover 状态机（design §13.3），纯规则层。
//
//   pre ──freeze──▶ frozen ──flip──▶ live
//         ◀─rollback─┘
//
// freeze 后旧 admission（/code/rounds 与 webhook code-round writer）拒新工作；
// flip 铸 writer generation，Mission 成为唯一 writer。rollback 只在 frozen
// （零副作用）合法——flip 之后新 writer 已可能外发（push/MR/comment），机器
// 不猜「能否回退」：typed 拒，人走 stop/reconcile/handoff（§4.8）。

export interface CutoverState {
  readonly phase: 'pre' | 'frozen' | 'live'
  readonly frozenAt: number | null
  readonly flippedAt: number | null
  /** flip 时铸造的 writer generation（审计/对拍用）。 */
  readonly generation: string | null
}

export const INITIAL_CUTOVER_STATE: CutoverState = {
  phase: 'pre',
  frozenAt: null,
  flippedAt: null,
  generation: null,
}

export type CutoverCommand = 'freeze' | 'flip' | 'rollback'

export type CutoverTransition =
  | { readonly ok: true; readonly next: CutoverState }
  | { readonly ok: false; readonly code: string; readonly detail: string }

export function decideCutoverTransition(
  state: CutoverState,
  command: CutoverCommand,
  input: { readonly now: number; readonly mintGeneration: () => string },
): CutoverTransition {
  if (command === 'freeze') {
    if (state.phase !== 'pre') {
      return {
        ok: false,
        code: 'cutover-phase-invalid',
        detail: `freeze requires pre, was ${state.phase}`,
      }
    }
    return { ok: true, next: { ...state, phase: 'frozen', frozenAt: input.now } }
  }
  if (command === 'flip') {
    if (state.phase !== 'frozen') {
      return {
        ok: false,
        code: 'cutover-phase-invalid',
        detail: `flip requires frozen, was ${state.phase}`,
      }
    }
    return {
      ok: true,
      next: { ...state, phase: 'live', flippedAt: input.now, generation: input.mintGeneration() },
    }
  }
  // rollback
  if (state.phase === 'frozen') {
    return { ok: true, next: { ...state, phase: 'pre', frozenAt: null } }
  }
  if (state.phase === 'live') {
    return {
      ok: false,
      code: 'cutover-rollback-after-flip',
      detail: 'writer generation already flipped; roll forward via stop/reconcile/handoff',
    }
  }
  return { ok: false, code: 'cutover-phase-invalid', detail: 'nothing to roll back' }
}

/** 旧 writer 的 admission 谓词：仅 pre 放行。 */
export function legacyAdmissionAllowedIn(state: CutoverState): boolean {
  return state.phase === 'pre'
}

/** 存储行反序列化（坏 JSON / 未知 phase 一律回 INITIAL——最保守放行面）。 */
export function parseCutoverState(raw: string | null): CutoverState {
  if (raw === null) return INITIAL_CUTOVER_STATE
  try {
    const parsed = JSON.parse(raw) as Partial<CutoverState>
    if (parsed.phase !== 'pre' && parsed.phase !== 'frozen' && parsed.phase !== 'live') {
      return INITIAL_CUTOVER_STATE
    }
    return {
      phase: parsed.phase,
      frozenAt: typeof parsed.frozenAt === 'number' ? parsed.frozenAt : null,
      flippedAt: typeof parsed.flippedAt === 'number' ? parsed.flippedAt : null,
      generation: typeof parsed.generation === 'string' ? parsed.generation : null,
    }
  } catch {
    return INITIAL_CUTOVER_STATE
  }
}
