// RFC-310 T9 —— CapabilityDefinition closed catalog（design.md §3.2，proposal §5）。
//
// 平台内置、版本化的能力合同：用户不能新增 capability id，也不能改阶段序列；
// 扩展能力必须发新 RFC 升 contract version，在途 ActionRun 按旧 validator 结算。
// ActionTemplate（用户资源）只能实现 agent 能力、且不可覆盖本表的任何字段。

import { z } from 'zod'

export const PROGRAM_CAPABILITY_IDS = [
  'requirement.materialize',
  'change.seed-uploads',
  'repository.inspect',
  'employee.select',
  'policy.decide',
  'verification.run',
] as const

export const ADAPTER_CAPABILITY_IDS = [
  'requirement.acquire',
  'mr.collect',
  'pipeline.collect',
] as const

export const AGENT_CAPABILITY_IDS = [
  'requirement.analyze',
  'change.implement',
  'change.review',
  'verification.repair',
  'mr.feedback.apply',
  'pipeline.repair',
  'conflict.repair',
  'mr.review.external',
  'problem.classify',
  'approval.prepare',
] as const

export const PLATFORM_EFFECT_CAPABILITY_IDS = [
  'change.publish',
  'mr.ensure',
  'mr.feedback.report',
  'requirement.questions.publish',
  'requirement.answers.collect',
  'pipeline.rerun',
  'pipeline.trigger',
  'mission.readiness.publish',
  'mission.track-terminal',
] as const

export const CAPABILITY_IDS = [
  ...PROGRAM_CAPABILITY_IDS,
  ...ADAPTER_CAPABILITY_IDS,
  ...AGENT_CAPABILITY_IDS,
  ...PLATFORM_EFFECT_CAPABILITY_IDS,
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]
export type AgentCapabilityId = (typeof AGENT_CAPABILITY_IDS)[number]

export const capabilityIdSchema = z.enum(CAPABILITY_IDS)
export const agentCapabilityIdSchema = z.enum(AGENT_CAPABILITY_IDS)

export type CapabilityExecutionKind = 'program' | 'adapter' | 'agent' | 'platform-effect'
export type CapabilityWorkspaceMode =
  | 'none'
  | 'read-only'
  | 'edit-business-files'
  | 'edit-conflicts'

/** 每个能力固定的阶段序列（§8.1）；用户不可编排。 */
export const CAPABILITY_STAGES = [
  'freeze-input',
  'materialize',
  'execute',
  'validate',
  'receipt',
] as const
export type CapabilityStageId = (typeof CAPABILITY_STAGES)[number]

export type DevelopmentEffectKind =
  | 'upload.place'
  | 'source.prepare-candidate'
  | 'source.commit'
  | 'source.push'
  | 'mr.ensure'
  | 'mr.comment.create'
  | 'mr.comment.update'
  | 'mr.feedback.reply'
  | 'mr.labels.reconcile'
  | 'pipeline.trigger'
  | 'pipeline.rerun'
  | 'requirement.questions.publish'
  | 'requirement.answers.collect'

export interface CapabilityDefinition {
  readonly id: CapabilityId
  readonly contractVersion: number
  readonly executionKind: CapabilityExecutionKind
  readonly inputSchemaId: string
  readonly outputSchemaId: string
  readonly workspaceMode: CapabilityWorkspaceMode
  readonly stages: readonly CapabilityStageId[]
  readonly semanticValidatorId: string
  readonly allowedEffectKinds: readonly DevelopmentEffectKind[]
}

function def(
  id: CapabilityId,
  executionKind: CapabilityExecutionKind,
  workspaceMode: CapabilityWorkspaceMode,
  allowedEffectKinds: readonly DevelopmentEffectKind[] = [],
): CapabilityDefinition {
  return {
    id,
    contractVersion: 1,
    executionKind,
    inputSchemaId: `${id}#input@1`,
    outputSchemaId: `${id}#output@1`,
    workspaceMode,
    stages: CAPABILITY_STAGES,
    semanticValidatorId: `${id}#semantic@1`,
    allowedEffectKinds,
  }
}

/** closed catalog：代码即事实源；顺序与 CAPABILITY_IDS 一致。 */
export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  def('requirement.materialize', 'program', 'none'),
  def('change.seed-uploads', 'program', 'none', ['upload.place']),
  def('repository.inspect', 'program', 'read-only'),
  def('employee.select', 'program', 'none'),
  def('policy.decide', 'program', 'none'),
  def('verification.run', 'program', 'read-only'),
  def('requirement.acquire', 'adapter', 'none'),
  def('mr.collect', 'adapter', 'none'),
  def('pipeline.collect', 'adapter', 'none'),
  def('requirement.analyze', 'agent', 'read-only'),
  def('change.implement', 'agent', 'edit-business-files'),
  def('change.review', 'agent', 'read-only'),
  def('verification.repair', 'agent', 'edit-business-files'),
  def('mr.feedback.apply', 'agent', 'edit-business-files'),
  def('pipeline.repair', 'agent', 'edit-business-files'),
  def('conflict.repair', 'agent', 'edit-conflicts'),
  def('mr.review.external', 'agent', 'read-only'),
  def('problem.classify', 'agent', 'read-only'),
  def('approval.prepare', 'agent', 'read-only'),
  def('change.publish', 'platform-effect', 'none', [
    'source.prepare-candidate',
    'source.commit',
    'source.push',
  ]),
  def('mr.ensure', 'platform-effect', 'none', ['mr.ensure']),
  def('mr.feedback.report', 'platform-effect', 'none', ['mr.feedback.reply']),
  def('requirement.questions.publish', 'platform-effect', 'none', [
    'requirement.questions.publish',
  ]),
  def('requirement.answers.collect', 'platform-effect', 'none', ['requirement.answers.collect']),
  def('pipeline.rerun', 'platform-effect', 'none', ['pipeline.rerun']),
  def('pipeline.trigger', 'platform-effect', 'none', ['pipeline.trigger']),
  def('mission.readiness.publish', 'platform-effect', 'none', [
    'mr.comment.create',
    'mr.comment.update',
  ]),
  def('mission.track-terminal', 'platform-effect', 'none', []),
]

const byId = new Map(CAPABILITY_DEFINITIONS.map((d) => [d.id, d]))

export function capabilityDefinition(id: CapabilityId): CapabilityDefinition {
  const found = byId.get(id)
  if (found === undefined) throw new Error(`capability not in catalog: ${id}`)
  return found
}

export function isAgentCapability(id: CapabilityId): id is AgentCapabilityId {
  return (AGENT_CAPABILITY_IDS as readonly string[]).includes(id)
}
