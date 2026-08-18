// RFC-310 PR-5 T54 —— requirement.analyze 结果 → agent-validated facts 投影。
//
// §4.1：Agent outcome 只有经过 capability semantic validator 才能投影为
// `agent-validated` fact；本函数是 validator 通过之后的纯投影（catalog 里的
// requirement.affectedModuleIds / requirement.scopeDisposition 两个 leaf）。
// sourceRevision 由调用方给 attempt id——同一 attempt 的投影幂等、新 attempt
// 产生新 revision（decision dedup 因 cells 变化自然重开）。

import type { AgentOutcomeEnvelope } from './agentEnvelope'
import type { FactCell } from './factCell'
import type { FactCellValue } from './facts'

export function projectAnalysisCells(
  envelope: Extract<AgentOutcomeEnvelope, { outcome: 'completed' }>,
  sourceRevision: string,
): Record<string, FactCell<FactCellValue>> {
  if (envelope.result.capabilityId !== 'requirement.analyze') return {}
  const known = (value: FactCellValue): FactCell<FactCellValue> => ({
    state: 'known',
    value,
    sourceRevision,
  })
  return {
    'requirement.affectedModuleIds': known([...envelope.result.affectedModuleRefs].sort()),
    'requirement.scopeDisposition': known(envelope.result.scopeDisposition),
  }
}
