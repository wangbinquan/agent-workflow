// RFC-310 PR-9 T94 —— legacy 资产迁移分析器（design §13.1/§13.2）。
//
// 输入是 legacy `capability_templates` / `repo_capability_config` 的行 DTO
// （读侧在 infrastructure/migrationAssets.ts），输出可审计 MigrationReport：
// 每行 legacy 资产逐项分类为 mappable / partial / blocked，映射产物只到
// **draft**（validate 不 publish），任何无法机械映射的项显式列出——绝不让
// AI 猜等价规则（arbitrate/select/hook 一律 blocked）。
//
// legacy 能力名与 agent slot 名在这里以本地常量收束：架构锁禁止本模块
// import `@/modules/code-capability`，而这组字符串是被 PR-10 删除的**封闭
// 历史集合**——迁移器必须在 legacy 模块删除后仍能解释历史报告，钉死副本
// 正是正确形态（对拍锚：code-capability/domain/stageContract.ts CODE_CAPABILITIES、
// requirementEnvelope.ts COMPREHEND/IMPLEMENT_AGENT_SLOT 等）。
//
// 判定原则（呈报为契约判断点）：
//   - mr-review 永远 'partial' + 'mr-review-purpose-choice'：change.review 与
//     mr.review.external 两个候选 draft 都生成，但必须人工二选一，不能静默
//     复制成两份 active（§13.2）。
//   - entry/collect/classify 脚本 → typed adapter candidates（固定名→purpose
//     映射，不是 AI 猜测）；但 materialize 阶段不落库——adapter create 强制
//     strict content + scripts:author，伪造 executableRef 会产出说谎的资源。
//   - hooks 全部 blocked（写树/中止/自由注入默认拒绝，§13.2 最后一行）。
//   - agent slot 未配置 → 不生成该 draft，记 'slot-unassigned:<slot>'。

import { canonicalDigest } from '../domain/canonicalJson'
import { defaultAutomationPolicyContent } from '../domain/automationPolicy'
import type { AgentCapabilityId } from '../domain/capabilityDefinition'

// ---------------------------------------------------------------------------
// legacy 行 DTO（读侧填充；JSON 列以原文传入，解析在本文件内做且必须宽容——
// 历史行可能是任何年代的形状，解析失败本身就是一个 blocked 理由而不是崩溃）。
// ---------------------------------------------------------------------------

export interface LegacyTemplateRow {
  readonly id: string
  readonly name: string
  readonly capability: string
  readonly scriptsJson: string
  readonly hooksJson: string
  readonly paramSchemaJson: string
  readonly paramDefaultsJson: string
  readonly agentBySlotJson: string
  readonly promptBySlotJson: string
  readonly paramsJson: string
  readonly upstreamId: string | null
  readonly upstreamVersion: number | null
  readonly baseDigest: string | null
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
  readonly builtin: boolean
}

export interface LegacyMatrixRow {
  readonly repoId: string
  readonly capability: string
  readonly templateId: string | null
  readonly enabled: boolean
  readonly triggerConfigJson: string
}

export interface AnalyzeLegacyInput {
  readonly templates: readonly LegacyTemplateRow[]
  readonly matrix: readonly LegacyMatrixRow[]
}

// ---------------------------------------------------------------------------
// 报告形状（design §13.2：每项 draft 带 migrationStatus/blockedReasons/
// sourceDigest；报告本身是 cutover preflight 的对账物料）。
// ---------------------------------------------------------------------------

export type MigrationTargetResource =
  | 'action-template'
  | 'digital-employee'
  | 'automation-policy'
  | 'development-adapter'
  | 'repository-assignment'

export interface MigrationTarget {
  readonly resource: MigrationTargetResource
  readonly proposedName: string
  /** action-template 目标的 capability（materialize 需要）；其余 null。 */
  readonly capabilityId: AgentCapabilityId | null
  /** 对应资源 content 形状的 draft（draft 层宽容存储；publish 才 strict）。 */
  readonly draft: unknown
  /** 人工项：需绑定 PipelineAdapter、需选择用途、占位 ref 需替换等。 */
  readonly notes: readonly string[]
}

export type MigrationDisposition = 'mappable' | 'partial' | 'blocked'

export interface MigrationItem {
  readonly legacyKind: 'capability-template' | 'repo-capability-config'
  readonly legacyId: string
  readonly legacyName: string
  readonly legacyCapability: string | null
  /** legacy 行核心字段的 canonicalDigest——同行复跑必得同值（可对账）。 */
  readonly sourceDigest: string
  readonly disposition: MigrationDisposition
  readonly targets: readonly MigrationTarget[]
  readonly blockedReasons: readonly string[]
  /** owner/visibility 沿 legacy 行带给 materialize。 */
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface MigrationReport {
  readonly generatedAt: number
  readonly items: readonly MigrationItem[]
  readonly summary: {
    readonly total: number
    readonly mappable: number
    readonly partial: number
    readonly blocked: number
  }
}

// ---------------------------------------------------------------------------
// legacy 封闭集合（钉死的历史副本，见文件头）。
// ---------------------------------------------------------------------------

const LEGACY_CAPABILITIES = [
  'mr-review',
  'mr-comment-fix',
  'requirement',
  'ci-fix',
  'mr-monitor',
] as const
type LegacyCapability = (typeof LEGACY_CAPABILITIES)[number]

function isLegacyCapability(value: string): value is LegacyCapability {
  return (LEGACY_CAPABILITIES as readonly string[]).includes(value)
}

/** legacy stage contract 的 agent slot 名（requirement 是双 slot，其余单 slot）。 */
const LEGACY_SLOTS = {
  'mr-review': 'reviewer',
  'mr-comment-fix': 'fixer',
  'ci-fix': 'ci-fixer',
  requirementAnalyze: 'analyst',
  requirementImplement: 'implementer',
} as const

type ScriptKind = 'entry' | 'collect' | 'classify' | 'arbitrate' | 'select'

/** 固定的脚本名→adapter purpose 映射（typed，不是按内容猜测）。 */
const SCRIPT_ADAPTER_PURPOSE: Readonly<
  Record<
    'entry' | 'collect' | 'classify',
    'requirement-source' | 'pipeline-gate' | 'pipeline-classifier'
  >
> = {
  entry: 'requirement-source',
  collect: 'pipeline-gate',
  classify: 'pipeline-classifier',
}

// ---------------------------------------------------------------------------
// 宽容 JSON 解析（历史行形状不齐是 blocked 理由，不是异常）。
// ---------------------------------------------------------------------------

function parseRecord(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function parseArray(json: string): unknown[] | null {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

interface LegacyScript {
  readonly language: string
  readonly script: string
}

function scriptOf(scripts: Record<string, unknown> | null, kind: ScriptKind): LegacyScript | null {
  if (scripts === null) return null
  const raw = scripts[kind]
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const body = typeof rec.script === 'string' ? rec.script : ''
  if (body.trim() === '') return null
  return { language: typeof rec.language === 'string' ? rec.language : 'unknown', script: body }
}

function slotAgent(agents: Record<string, unknown> | null, slot: string): string | null {
  if (agents === null) return null
  const value = agents[slot]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function slotPrompt(prompts: Record<string, unknown> | null, slot: string): string {
  if (prompts === null) return ''
  const value = prompts[slot]
  return typeof value === 'string' ? value : ''
}

// ---------------------------------------------------------------------------
// sourceDigest：legacy 行核心字段的 canonical digest（复跑稳定、对账用）。
// ---------------------------------------------------------------------------

export function legacyTemplateSourceDigest(row: LegacyTemplateRow): string {
  return canonicalDigest({
    kind: 'capability-template',
    id: row.id,
    name: row.name,
    capability: row.capability,
    scriptsJson: row.scriptsJson,
    hooksJson: row.hooksJson,
    paramSchemaJson: row.paramSchemaJson,
    paramDefaultsJson: row.paramDefaultsJson,
    agentBySlotJson: row.agentBySlotJson,
    promptBySlotJson: row.promptBySlotJson,
    paramsJson: row.paramsJson,
    upstreamId: row.upstreamId,
    upstreamVersion: row.upstreamVersion,
    baseDigest: row.baseDigest,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin,
  })
}

function matrixSourceDigest(repoId: string, rows: readonly LegacyMatrixRow[]): string {
  const cells = [...rows]
    .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))
    .map((r) => ({
      capability: r.capability,
      templateId: r.templateId,
      enabled: r.enabled,
      triggerConfigJson: r.triggerConfigJson,
    }))
  return canonicalDigest({ kind: 'repo-capability-config', repoId, cells })
}

// ---------------------------------------------------------------------------
// ActionTemplate draft 组装（domain/actionTemplate.ts strict schema 的形状；
// 无法机械得到的 ref 用显式占位 + note——publish 门是诚实的最终裁判）。
// ---------------------------------------------------------------------------

/** 占位 ref：让 draft 结构完整但 publish 必然失败在「资源不存在」这个诚实信号上。 */
export const MIGRATION_PLACEHOLDER_REF = 'migration-placeholder'

function actionTemplateDraft(input: {
  readonly capabilityId: AgentCapabilityId
  readonly agentRef: string
  readonly promptSupplement: string
}): unknown {
  return {
    schemaVersion: 1,
    capabilityId: input.capabilityId,
    capabilityContractVersion: 1,
    labels: [],
    compatibility: [],
    executor: { kind: 'agent', agentRef: input.agentRef },
    runtimeProfileRef: MIGRATION_PLACEHOLDER_REF,
    promptSupplement: input.promptSupplement,
    skillRefs: [],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: MIGRATION_PLACEHOLDER_REF,
    retryDefaults: { sameSession: 2, freshSession: 1 },
  }
}

const TEMPLATE_BASE_NOTES = [
  'runtimeProfileRef/verificationProfileRef 为占位，publish 前需人工绑定真实资源',
  '新 no-Git/output contract 与旧运行面不同：validate 后必须人工 publish（§13.2）',
] as const

function templateTarget(input: {
  readonly proposedName: string
  readonly capabilityId: AgentCapabilityId
  readonly agentRef: string
  readonly promptSupplement: string
  readonly extraNotes?: readonly string[]
}): MigrationTarget {
  return {
    resource: 'action-template',
    proposedName: input.proposedName,
    capabilityId: input.capabilityId,
    draft: actionTemplateDraft(input),
    notes: [...TEMPLATE_BASE_NOTES, ...(input.extraNotes ?? [])],
  }
}

// ---------------------------------------------------------------------------
// 单模板分析
// ---------------------------------------------------------------------------

function analyzeTemplate(row: LegacyTemplateRow): MigrationItem {
  const targets: MigrationTarget[] = []
  const blockedReasons: string[] = []

  const scripts = parseRecord(row.scriptsJson)
  const agents = parseRecord(row.agentBySlotJson)
  const prompts = parseRecord(row.promptBySlotJson)
  const hooks = parseArray(row.hooksJson)

  if (scripts === null && row.scriptsJson.trim() !== '{}') {
    blockedReasons.push('scripts-json-unparseable')
  }
  if (hooks === null) {
    blockedReasons.push('hooks-json-unparseable')
  }

  // hooks：全部 blocked（写树/中止/自由注入默认拒绝——§13.2 最后一行）。
  for (const hook of hooks ?? []) {
    const rec = typeof hook === 'object' && hook !== null ? (hook as Record<string, unknown>) : {}
    const stage = typeof rec.stage === 'string' ? rec.stage : 'unknown'
    const phase = typeof rec.phase === 'string' ? rec.phase : 'unknown'
    blockedReasons.push(`hook:${stage}:${phase}`)
  }

  // arbitrate/select：报告中的「必须人工改写规则」，绝不生成等价规则。
  if (scriptOf(scripts, 'arbitrate') !== null) blockedReasons.push('arbitrate-script')
  if (scriptOf(scripts, 'select') !== null) blockedReasons.push('select-script')

  // entry/collect/classify：typed adapter candidates（report-only proposal；
  // materialize 不落库——见文件头判定原则）。
  for (const kind of ['entry', 'collect', 'classify'] as const) {
    const script = scriptOf(scripts, kind)
    if (script === null) continue
    targets.push({
      resource: 'development-adapter',
      proposedName: `${row.name}-${kind}-adapter`,
      capabilityId: null,
      draft: {
        schemaVersion: 1,
        purpose: SCRIPT_ADAPTER_PURPOSE[kind],
        sourceScript: { kind, language: script.language, script: script.script },
      },
      notes: [
        'adapter candidate 仅作提案：executableRef 需人工提供，contract/probe 通过后才能发布（§13.2）',
        `purpose 由脚本槽位名固定映射（${kind} → ${SCRIPT_ADAPTER_PURPOSE[kind]}），非按内容推断`,
      ],
    })
  }

  const capability = row.capability
  if (!isLegacyCapability(capability)) {
    blockedReasons.push(`unknown-capability:${capability}`)
  } else if (capability === 'requirement') {
    // requirement → requirement.analyze / change.implement 双 draft（slot 拆分）。
    const pairs = [
      {
        slot: LEGACY_SLOTS.requirementAnalyze,
        cap: 'requirement.analyze' as const,
        suffix: 'analyze',
      },
      {
        slot: LEGACY_SLOTS.requirementImplement,
        cap: 'change.implement' as const,
        suffix: 'implement',
      },
    ]
    for (const pair of pairs) {
      const agent = slotAgent(agents, pair.slot)
      if (agent === null) {
        blockedReasons.push(`slot-unassigned:${pair.slot}`)
        continue
      }
      targets.push(
        templateTarget({
          proposedName: `${row.name}-${pair.suffix}`,
          capabilityId: pair.cap,
          agentRef: agent,
          promptSupplement: slotPrompt(prompts, pair.slot),
        }),
      )
    }
  } else if (capability === 'mr-comment-fix') {
    const agent = slotAgent(agents, LEGACY_SLOTS['mr-comment-fix'])
    if (agent === null) {
      blockedReasons.push(`slot-unassigned:${LEGACY_SLOTS['mr-comment-fix']}`)
    } else {
      targets.push(
        templateTarget({
          proposedName: row.name,
          capabilityId: 'mr.feedback.apply',
          agentRef: agent,
          promptSupplement: slotPrompt(prompts, LEGACY_SLOTS['mr-comment-fix']),
          extraNotes: ['旧输出/路径权限与新 contract 不兼容，publish 前逐项核验（§13.2）'],
        }),
      )
    }
  } else if (capability === 'ci-fix') {
    const agent = slotAgent(agents, LEGACY_SLOTS['ci-fix'])
    if (agent === null) {
      blockedReasons.push(`slot-unassigned:${LEGACY_SLOTS['ci-fix']}`)
    } else {
      targets.push(
        templateTarget({
          proposedName: row.name,
          capabilityId: 'pipeline.repair',
          agentRef: agent,
          promptSupplement: slotPrompt(prompts, LEGACY_SLOTS['ci-fix']),
          extraNotes: ['需绑定 PipelineAdapter 与新 evidence contract 后才可用（§13.2）'],
        }),
      )
    }
  } else if (capability === 'mr-review') {
    // 两个候选都生成，但必须人工二选一——partial + purpose-choice。
    const agent = slotAgent(agents, LEGACY_SLOTS['mr-review'])
    if (agent === null) {
      blockedReasons.push(`slot-unassigned:${LEGACY_SLOTS['mr-review']}`)
    } else {
      const prompt = slotPrompt(prompts, LEGACY_SLOTS['mr-review'])
      const choiceNote =
        'mr-review 必须人工选择用途（change.review 或 mr.review.external），不能双份 active（§13.2）'
      targets.push(
        templateTarget({
          proposedName: `${row.name}-change-review`,
          capabilityId: 'change.review',
          agentRef: agent,
          promptSupplement: prompt,
          extraNotes: [choiceNote],
        }),
        templateTarget({
          proposedName: `${row.name}-mr-review-external`,
          capabilityId: 'mr.review.external',
          agentRef: agent,
          promptSupplement: prompt,
          extraNotes: [choiceNote],
        }),
      )
      blockedReasons.push('mr-review-purpose-choice')
    }
  } else {
    // mr-monitor → AutomationPolicy draft（monitor 不再是模板）；
    // fixed 3 CI campaigns → retry.freshSessionReruns=3 机械迁入（§13.2）。
    const base = defaultAutomationPolicyContent()
    targets.push({
      resource: 'automation-policy',
      proposedName: row.name,
      capabilityId: null,
      draft: { ...base, retry: { ...base.retry, freshSessionReruns: 3 } },
      notes: [
        'monitor 不再是 ActionTemplate：触发/采集面改由 employee.pipelineProviders + MR provider binding 人工配置',
        'legacy fixed-3 CI campaigns 机械迁入 retry.freshSessionReruns=3',
      ],
    })
  }

  const disposition: MigrationDisposition =
    targets.length === 0 ? 'blocked' : blockedReasons.length > 0 ? 'partial' : 'mappable'

  return {
    legacyKind: 'capability-template',
    legacyId: row.id,
    legacyName: row.name,
    legacyCapability: capability,
    sourceDigest: legacyTemplateSourceDigest(row),
    disposition,
    targets,
    blockedReasons,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
  }
}

// ---------------------------------------------------------------------------
// 矩阵分析：按 repo 聚合五格；只有五格闭包且引用的模板全部非 blocked 才生成
// DigitalEmployee draft + assignment proposal（§13.2；仍不自动发布）。
// ---------------------------------------------------------------------------

/** 占位 versionedRef：revision 0 = 「尚未 materialize/publish」的显式标记。 */
function placeholderRef(proposedName: string): { id: string; revision: number } {
  return { id: `migration:${proposedName}`, revision: 0 }
}

function analyzeMatrixRepo(
  repoId: string,
  rows: readonly LegacyMatrixRow[],
  templateItems: ReadonlyMap<string, MigrationItem>,
): MigrationItem {
  const blockedReasons: string[] = []
  const notes: string[] = []
  const byCapability = new Map<string, LegacyMatrixRow>()
  for (const row of rows) byCapability.set(row.capability, row)

  // 引用的模板 item（能力 → 该格模板的分析结果）。
  const cellItems = new Map<LegacyCapability, MigrationItem>()
  for (const capability of LEGACY_CAPABILITIES) {
    const cell = byCapability.get(capability)
    if (cell === undefined || !cell.enabled || cell.templateId === null) {
      blockedReasons.push(`matrix-incomplete:${capability}`)
      continue
    }
    const item = templateItems.get(cell.templateId)
    if (item === undefined) {
      blockedReasons.push(`matrix-conflict:template-missing:${capability}`)
      continue
    }
    if (item.disposition === 'blocked') {
      blockedReasons.push(`matrix-conflict:template-blocked:${capability}`)
      continue
    }
    cellItems.set(capability, item)
  }

  const targets: MigrationTarget[] = []
  const closed = blockedReasons.length === 0
  if (closed) {
    // routes：每个新能力 fallback 指向对应模板 candidate 的 proposedName 占位。
    const templateRefByCapability = new Map<AgentCapabilityId, string>()
    for (const item of cellItems.values()) {
      for (const target of item.targets) {
        if (target.resource !== 'action-template' || target.capabilityId === null) continue
        // mr-review 的双候选默认路由 change.review；external 候选留给人工改选。
        if (target.capabilityId === 'mr.review.external') continue
        if (!templateRefByCapability.has(target.capabilityId)) {
          templateRefByCapability.set(target.capabilityId, target.proposedName)
        }
      }
      if (item.blockedReasons.includes('mr-review-purpose-choice')) {
        notes.push('review 路由默认取 change.review 候选；若人工选择 mr.review.external 需改写路由')
      }
    }
    const monitorItem = cellItems.get('mr-monitor')
    const policyTarget = monitorItem?.targets.find((t) => t.resource === 'automation-policy')
    const policyName = policyTarget?.proposedName ?? MIGRATION_PLACEHOLDER_REF
    if (policyTarget === undefined) {
      notes.push('矩阵未产出 policy candidate，defaultPolicyRef 为占位，需人工绑定')
    }

    const employeeName = `migrated-employee-${repoId}`
    targets.push({
      resource: 'digital-employee',
      proposedName: employeeName,
      capabilityId: null,
      draft: {
        schemaVersion: 1,
        description: `Migrated from legacy repo ${repoId} capability matrix (RFC-310 §13.2)`,
        supportedRepositoryFacts: [],
        capabilityRoutes: [...templateRefByCapability.entries()].map(([capabilityId, name]) => ({
          capabilityId,
          rules: [],
          fallbackTemplateRef: placeholderRef(name),
        })),
        requirementSources: [],
        pipelineProviders: [],
        defaultPolicyRef: placeholderRef(policyName),
      },
      notes: [
        'templateRef/policyRef 为 proposedName 占位（revision 0）：materialize 后需人工替换为真实 id/revision 并逐个 publish',
        'requirementSources/pipelineProviders 需人工绑定 adapter（legacy trigger 配置不自动翻译）',
        ...notes,
      ],
    })
    targets.push({
      resource: 'repository-assignment',
      proposedName: `assignment-${repoId}`,
      capabilityId: null,
      draft: {
        scopeKind: 'repository',
        scopeRef: repoId,
        employeeRef: `migration:${employeeName}`,
        selectionPolicyRef: `migration:${policyName}`,
      },
      notes: ['assignment 仅为 proposal：绝不自动写入路由面，cutover preflight 通过后人工启用'],
    })
  }

  return {
    legacyKind: 'repo-capability-config',
    legacyId: repoId,
    legacyName: `repo ${repoId}`,
    legacyCapability: null,
    sourceDigest: matrixSourceDigest(repoId, rows),
    disposition: closed ? 'mappable' : 'blocked',
    targets,
    blockedReasons,
    ownerUserId: null,
    visibility: 'private',
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function analyzeLegacyAssets(
  input: AnalyzeLegacyInput,
  generatedAt: number,
): MigrationReport {
  const templateItems = input.templates.map(analyzeTemplate)
  const byTemplateId = new Map(templateItems.map((item) => [item.legacyId, item]))

  const byRepo = new Map<string, LegacyMatrixRow[]>()
  for (const row of input.matrix) {
    const list = byRepo.get(row.repoId) ?? []
    list.push(row)
    byRepo.set(row.repoId, list)
  }
  const matrixItems = [...byRepo.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([repoId, rows]) => analyzeMatrixRepo(repoId, rows, byTemplateId))

  const items = [...templateItems, ...matrixItems]
  return {
    generatedAt,
    items,
    summary: {
      total: items.length,
      mappable: items.filter((i) => i.disposition === 'mappable').length,
      partial: items.filter((i) => i.disposition === 'partial').length,
      blocked: items.filter((i) => i.disposition === 'blocked').length,
    },
  }
}

// ---------------------------------------------------------------------------
// T96（报告半）：人读渲染。纯函数，CLI 入口在 src/cli/migrationReport.ts。
// ---------------------------------------------------------------------------

export function printMigrationReport(report: MigrationReport): string {
  const lines: string[] = []
  lines.push(
    `RFC-310 migration report — generated at ${new Date(report.generatedAt).toISOString()}`,
  )
  lines.push(
    `total ${report.summary.total} · mappable ${report.summary.mappable} · partial ${report.summary.partial} · blocked ${report.summary.blocked}`,
  )
  lines.push('')
  for (const item of report.items) {
    const cap = item.legacyCapability === null ? '' : ` [${item.legacyCapability}]`
    lines.push(`${item.disposition.toUpperCase()}  ${item.legacyKind}${cap}  ${item.legacyName}`)
    lines.push(`  source ${item.legacyId} digest ${item.sourceDigest.slice(0, 16)}…`)
    for (const target of item.targets) {
      lines.push(`  → ${target.resource}  ${target.proposedName}`)
      for (const note of target.notes) lines.push(`      note: ${note}`)
    }
    for (const reason of item.blockedReasons) lines.push(`  ✗ ${reason}`)
    lines.push('')
  }
  return lines.join('\n')
}
