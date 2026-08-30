// RFC-294 review 2026-08-30 —— architecture status 投影渲染器。
//
// 为什么存在（review §A2）：RFC-294 三件套里同一组指标在 ≥5 处手抄（proposal §2、
// design §2/§17、plan §1/§14），每个 wave 收尾都要人肉同步，而且已经与 committed report
// 漂移（design §17 写 AppDeps 54、plan §1 写 53、report 是 48；SCC 文档 4/6、report 3/5）。
// 本文件只读 committed `architecture/*.json`，把它们渲染成
// `design/RFC-294-backend-layered-target-architecture/status.md`；三件套散文不再抄数字，
// 只引用该文件。渲染是纯函数：`architecture:write` / `architecture:status` 与
// `rfc294-review-status-projection.test.ts` 共用同一份实现，投影相等由后者钉死。
//
// 输入只有 committed 账本、没有源码扫描：共享工作树里别人的在制品不会漂进这里。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ARCHITECTURE_STATUS_PATH =
  'design/RFC-294-backend-layered-target-architecture/status.md'

type Json = Record<string, unknown>

export interface ArchitectureStatusInputs {
  readonly report: Json
  readonly facades: readonly Json[]
  readonly observedEdges: readonly Json[]
  readonly architectureExceptions: readonly Json[]
  readonly requiredPorts: readonly Json[]
  readonly publicSurfaces: readonly Json[]
  readonly owners: readonly Json[]
}

function readJson(repoRoot: string, path: string): Json {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as Json
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : []
}

export function readArchitectureStatusInputs(repoRoot: string): ArchitectureStatusInputs {
  const crossContext = readJson(repoRoot, 'architecture/cross-context-imports.json')
  return {
    report: readJson(repoRoot, 'architecture/current-report.json'),
    facades: list(readJson(repoRoot, 'architecture/facades.json').entries),
    observedEdges: list(crossContext.observedEdges),
    architectureExceptions: list(crossContext.architectureExceptions),
    requiredPorts: list(crossContext.requiredPorts),
    publicSurfaces: list(readJson(repoRoot, 'architecture/public-surfaces.json').entries),
    owners: list(readJson(repoRoot, 'architecture/module-symbol-owners.json').entries),
  }
}

const MODULES_PREFIX = 'packages/backend/src/modules/'
const BACKEND_PREFIX = 'packages/backend/src/'

function text(value: unknown): string {
  return value === null || value === undefined ? '(未定)' : String(value)
}

function size(value: unknown): string {
  if (Array.isArray(value)) return String(value.length)
  return text(value)
}

function tally(keys: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return [...counts.entries()].sort(
    ([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount - leftCount || leftKey.localeCompare(rightKey),
  )
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ]
}

function tallyTable(title: string, keys: readonly string[], label: string): string[] {
  return [
    `### ${title}`,
    '',
    ...table(
      [label, '数量'],
      tally(keys).map(([key, count]) => [key, String(count)]),
    ),
  ]
}

/** 每个生产文件只算一次：owner 账本按 symbol 记，同一文件会出现多次。 */
function uniqueFiles(owners: readonly Json[]): Json[] {
  const seen = new Set<string>()
  const out: Json[] = []
  for (const entry of owners) {
    const file = String(entry.file)
    if (!file.startsWith(BACKEND_PREFIX) || seen.has(file)) continue
    seen.add(file)
    out.push(entry)
  }
  return out
}

function hasConsumers(entry: Json): boolean {
  return (
    list(entry.consumerEdgeIds).length > 0 ||
    list(entry.productionConsumers).length > 0 ||
    list(entry.publicTypeConsumerIds).length > 0
  )
}

export function renderArchitectureStatus(inputs: ArchitectureStatusInputs): string {
  const metrics = (inputs.report.metrics ?? {}) as Json
  const denominators = (inputs.report.manifestDenominators ?? {}) as Json
  const files = uniqueFiles(inputs.owners)
  const moduleFiles = files.filter((entry) => String(entry.file).startsWith(MODULES_PREFIX))
  const legacyFiles = files.filter((entry) => !String(entry.file).startsWith(MODULES_PREFIX))
  const unconsumed = inputs.publicSurfaces.filter((entry) => !hasConsumers(entry))
  const deadPorts = inputs.requiredPorts.filter(
    (port) =>
      list(port.providerAdapters).length === 0 && list(port.consumerOwnerEntryIds).length === 0,
  )

  const lines: string[] = [
    '<!-- 由 `bun run architecture:status`（或 `architecture:write`）从 committed architecture/*.json 生成；不要手改。 -->',
    '',
    '# RFC-294 架构现状（生成）',
    '',
    `- 数据来源：\`architecture/current-report.json\` 及同批 canonical manifests（sourceDigest \`${text(inputs.report.sourceDigest)}\`）`,
    '- 用途：RFC-294 三件套不再手抄指标；散文引用本文件。同一组数字只在这里出现一次。',
    '- 判读规则：`plan.md` §1 的 architecture-significance filter 与各波退出门不变；本文件只回答“现在是什么”，不给 wave credit。',
    '',
    '## 1. 核心指标（`current-report.json` → `metrics`）',
    '',
    ...table(
      ['指标', '当前值'],
      [
        ['backend production TS 文件', size(metrics.backendProductionFiles)],
        ['`services/` 文件', size(metrics.serviceFiles)],
        [
          '`modules/**` 文件 / 非空 context',
          `${size(metrics.moduleFiles)} / ${size(metrics.moduleContexts)}`,
        ],
        [
          'backend 值级 SCC / 全仓值级 SCC',
          `${size(metrics.backendValueSccs)} / ${size(metrics.repoValueSccs)}`,
        ],
        ['`KNOWN_VIOLATIONS`', size(metrics.knownViolations)],
        [
          'route→DB / transport→DB 值级边',
          `${size(metrics.routeToDbEdges)} / ${size(metrics.transportToDbEdges)}`,
        ],
        ['route/MCP `AppDeps` consumer 文件', size(metrics.appDepsConsumers)],
        ['production ambient wiring seam', size(metrics.ambientWiringEntries)],
        ['background work entries', size(metrics.backgroundEntries)],
        [
          'direct native `setInterval`（call / files）',
          `${size(metrics.directNativeIntervals)} / ${size(metrics.directNativeIntervalFiles)}`,
        ],
        ['direct native timers（全部）', size(metrics.directNativeTimers)],
        [
          'RFC-317 boundary census（inbound / outbound）',
          `${size(metrics.inboundBoundaryEdges)} / ${size(metrics.outboundBoundaryEdges)}`,
        ],
        ['`node_runs INSERT` 站点', size(metrics.nodeRunInsertSites)],
        ['first-party unresolved import', size(metrics.unresolvedFirstParty)],
      ],
    ),
    '## 2. 账本分母（`manifestDenominators`）',
    '',
    ...table(
      ['账本', '条目数'],
      Object.entries(denominators)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [`\`${key}\``, size(value)]),
    ),
    '## 3. 模块物理形状（`module-symbol-owners.json`，按文件去重）',
    '',
    ...tallyTable(
      '3.1 `modules/**` 文件按 context / layer',
      moduleFiles.map((entry) => `${text(entry.currentContext)} / ${text(entry.currentLayer)}`),
      'context / layer',
    ),
    ...tallyTable(
      '3.2 legacy backend 文件按目标 context（迁移 backlog）',
      legacyFiles.map((entry) => text(entry.targetContext)),
      'targetContext',
    ),
    '## 4. Facade 账本（`facades.json`）',
    '',
    ...tallyTable(
      '4.1 按目标 context',
      inputs.facades.map((entry) => text(entry.targetContext)),
      'targetContext',
    ),
    ...tallyTable(
      '4.2 按清偿波次',
      inputs.facades.map((entry) => text(entry.removeAfterWave)),
      'removeAfterWave',
    ),
    '## 5. 跨 context 边（`cross-context-imports.json`）',
    '',
    ...tallyTable(
      '5.1 observed edges 按 role',
      inputs.observedEdges.map((entry) => text(entry.role)),
      'role',
    ),
    ...tallyTable(
      '5.2 exact exceptions 按 rule',
      inputs.architectureExceptions.map((entry) => text(entry.rule)),
      'rule',
    ),
    ...tallyTable(
      '5.3 exact exceptions 按清偿波次',
      inputs.architectureExceptions.map((entry) => text(entry.removeAfterWave)),
      'removeAfterWave',
    ),
    '## 6. Public surface（`public-surfaces.json`）',
    '',
    ...tallyTable(
      '6.1 public symbol 按 context',
      inputs.publicSurfaces.map((entry) => text(entry.context)),
      'context',
    ),
    ...tallyTable(
      `6.2 零生产 consumer 的 public symbol 按 context（合计 ${unconsumed.length} / ${inputs.publicSurfaces.length}）`,
      unconsumed.map((entry) => text(entry.context)),
      'context',
    ),
    '## 7. Required ports（`cross-context-imports.json` → `requiredPorts`）',
    '',
    ...tallyTable(
      '7.1 按 status',
      inputs.requiredPorts.map((entry) => text(entry.status)),
      'status',
    ),
    `### 7.2 provider=0 且 consumer=0 的 required port（合计 ${deadPorts.length}）`,
    '',
    ...deadPorts.map((port) => `- \`${text(port.id)}\``),
    '',
  ]
  return lines.join('\n')
}
