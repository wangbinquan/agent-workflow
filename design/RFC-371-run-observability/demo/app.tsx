import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Card } from '../../../packages/frontend/src/components/Card'
import { TabBar } from '../../../packages/frontend/src/components/TabBar'
import { TableViewport } from '../../../packages/frontend/src/components/TableViewport'
import { Select } from '../../../packages/frontend/src/components/Select'
import { Segmented } from '../../../packages/frontend/src/components/Segmented'
import { StatusChip } from '../../../packages/frontend/src/components/StatusChip'
import { EmptyState } from '../../../packages/frontend/src/components/EmptyState'
import { Dialog } from '../../../packages/frontend/src/components/Dialog'
import { TextInput } from '../../../packages/frontend/src/components/Form'
import {
  ResourceIcon,
  type ResourceIconKey,
} from '../../../packages/frontend/src/components/icons/resourceIcons'
import i18n from '../../../packages/frontend/src/i18n/index'
import {
  agents,
  models,
  tasks,
  mainTask,
  total,
  cost,
  sumUsage,
  isPartial,
  num,
  short,
  dur,
  money,
  percentile,
  statusNames,
  startTime,
  SNAPSHOT,
  type Task,
  type Attempt,
  type Usage,
} from './fixture'

import { RuntimePricing } from './RuntimePricing'

void i18n.changeLanguage('zh-CN')
const tabDefs = [
  { key: 'overview', label: '总览' },
  { key: 'traces', label: '任务追踪' },
  { key: 'agents', label: 'Agent 分析' },
  { key: 'usage', label: 'Token 与成本' },
  { key: 'performance', label: '性能与异常' },
]
const categories = [
  { key: 'input', label: '非缓存输入' },
  { key: 'read', label: '缓存读取' },
  { key: 'write', label: '缓存写入' },
  { key: 'output', label: '输出' },
] as const
const Button = ({
  children,
  onClick,
  primary = false,
  ...props
}: {
  children: ReactNode
  onClick?: () => void
  primary?: boolean
  [key: string]: unknown
}) => (
  <button
    type="button"
    className={`btn btn--sm${primary ? ' btn--primary' : ''}`}
    onClick={onClick}
    {...props}
  >
    {children}
  </button>
)
const Name = ({ id }: { id: string }) => <>{agents.find((a) => a.id === id)?.name ?? id}</>
const Status = ({ value }: { value: string }) => (
  <StatusChip
    size="sm"
    withDot
    kind={
      value === 'done'
        ? 'success'
        : value === 'failed'
          ? 'danger'
          : value === 'running'
            ? 'info'
            : value === 'awaiting_human'
              ? 'warn'
              : 'neutral'
    }
  >
    {statusNames[value] ?? value}
  </StatusChip>
)
const tokenLabel = (rs: Attempt[]) =>
  !rs.length
    ? '0'
    : rs.every((r) => !r.usage)
      ? '—'
      : `${isPartial(rs) ? '≥ ' : ''}${short(total(sumUsage(rs)))}`
const costLabel = (rs: Attempt[]) =>
  rs.length && rs.every((r) => !r.usage)
    ? '—'
    : `${isPartial(rs) ? '≥ ' : ''}${money(rs.reduce((n, r) => n + cost(r), 0))}`
const allRuns = (ts: Task[]) => ts.flatMap((t) => t.attempts)
const Stat = ({ label, value, hint }: { label: string; value: string; hint: string }) => (
  <Card className="obs-stat">
    <span className="obs-muted">{label}</span>
    <strong>{value}</strong>
    <span className="obs-muted obs-small">{hint}</span>
  </Card>
)
const Legend = () => (
  <div className="obs-legend">
    {categories.map((c) => (
      <span key={c.key}>
        <i className={`obs-swatch obs-${c.key}`} />
        {c.label}
      </span>
    ))}
  </div>
)
function Breakdown({ usage }: { usage: Usage }) {
  const n = total(usage)
  return (
    <div
      className="obs-stacked"
      role="img"
      aria-label={categories.map((c) => `${c.label} ${num(usage[c.key])}`).join('，')}
    >
      {categories.map((c) => (
        <span
          key={c.key}
          className={`obs-${c.key}`}
          style={{ width: `${n ? (usage[c.key] / n) * 100 : 0}%` }}
          title={`${c.label} ${num(usage[c.key])}`}
        />
      ))}
    </div>
  )
}
function MetricStrip({ ts }: { ts: Task[] }) {
  const rs = allRuns(ts),
    completed = ts.filter((t) => ['done', 'failed'].includes(t.status))
  const p95 = percentile(
    completed.map((t) => t.duration),
    0.95,
  )
  const success = completed.filter((t) => t.status === 'done').length
  const complete = rs.filter((r) => r.usage && !r.partial).length
  return (
    <div className="obs-metrics">
      <Stat
        label="任务 / 成功率"
        value={`${ts.length} / ${completed.length ? ((success / completed.length) * 100).toFixed(0) + '%' : '—'}`}
        hint={`${success} 成功 / ${completed.length} 已完成或失败`}
      />
      <Stat
        label="已知 Token"
        value={tokenLabel(rs)}
        hint={`${complete}/${rs.length} 次执行用量完整`}
      />
      <Stat
        label="已知费用估算 · 人民币 CNY"
        value={
          rs.some((r) => r.usage)
            ? `${isPartial(rs) ? '≥ ' : ''}${money(rs.reduce((n, r) => n + cost(r), 0))}`
            : '—'
        }
        hint="示例费率 · 含缓存与全部尝试"
      />
      <Stat
        label="P95 完成历时"
        value={p95 === null ? '—' : dur(p95)}
        hint={`完成 / 失败样本 n=${completed.length} · 小样本`}
      />
    </div>
  )
}
function TaskTable({
  ts,
  onPick,
  compact = false,
}: {
  ts: Task[]
  onPick: (t: Task) => void
  compact?: boolean
}) {
  if (!ts.length)
    return <EmptyState title="没有匹配的任务" description="尝试调整仓库、时间范围或任务名称。" />
  return (
    <TableViewport label="任务观测列表" minWidth="md">
      <table className="data-table data-table--compact obs-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th className="obs-num">Token</th>
            <th className="obs-num">历时</th>
            {!compact && (
              <>
                <th className="obs-num">Agent / 执行</th>
                <th>用量数据</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {ts.map((t) => (
            <tr key={t.id}>
              <td>
                <button type="button" className="obs-link" onClick={() => onPick(t)}>
                  {t.name}
                </button>
                <div className="obs-small obs-muted">
                  {t.id} · {t.repo} · {t.source}
                </div>
              </td>
              <td>
                <Status value={t.status} />
              </td>
              <td className="obs-num">{tokenLabel(t.attempts)}</td>
              <td className="obs-num">
                {dur(t.duration)}
                {['running', 'awaiting_human'].includes(t.status) && (
                  <span className="obs-small obs-muted"> 已经过</span>
                )}
              </td>
              {!compact && (
                <>
                  <td className="obs-num">
                    {new Set(t.attempts.map((r) => r.agent)).size} / {t.attempts.length}
                  </td>
                  <td>
                    <StatusChip size="sm" kind={isPartial(t.attempts) ? 'warn' : 'neutral'}>
                      {t.attempts.every((r) => !r.usage)
                        ? '未上报'
                        : isPartial(t.attempts)
                          ? '部分数据'
                          : '完整'}
                    </StatusChip>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
function Trend({
  ts,
  onBucket,
  range,
}: {
  ts: Task[]
  onBucket: (ts: Task[], title: string) => void
  range: string
}) {
  const bins = Array.from({ length: range === '24' ? 8 : 7 }, (_, i) => {
    if (range === '24') {
      const ago = (7 - i) * 3
      return {
        label: new Date(SNAPSHOT - ago * 3600000).toLocaleTimeString('en-GB', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
        }),
        tasks: ts.filter((t) => t.ago >= ago && t.ago < ago + 3),
      }
    }
    return {
      label: `9/${22 + i}`,
      tasks: ts.filter(
        (t) =>
          new Date(startTime(t)).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) ===
          `2026-09-${22 + i}`,
      ),
    }
  })
  const max = Math.max(...bins.map((b) => total(sumUsage(allRuns(b.tasks)))), 1)
  return (
    <div>
      <div className="obs-chart-label">
        Token · 按任务开始时间归属{range === '24' ? ' · 每 3 小时，标注区间终点' : ''}
      </div>
      <div className="obs-bar-chart">
        <div className="obs-yaxis">
          <span>{short(max)}</span>
          <span>{short(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="obs-chart-bars">
          {bins.map((b, i) => {
            const usage = sumUsage(allRuns(b.tasks))
            return (
              <button
                type="button"
                key={i}
                className="obs-chart-column"
                aria-label={`${b.label}，${b.tasks.length} 个任务，${tokenLabel(allRuns(b.tasks))} Token，查看任务`}
                onClick={() => onBucket(b.tasks, `${b.label} 开始的任务`)}
              >
                <span
                  className="obs-chart-stack"
                  style={{ height: `${(total(usage) / max) * 100}%` }}
                >
                  {[...categories].reverse().map((c) => (
                    <span
                      key={c.key}
                      className={`obs-${c.key}`}
                      style={{
                        height: `${total(usage) ? (usage[c.key] / total(usage)) * 100 : 0}%`,
                      }}
                    />
                  ))}
                </span>
                <span className="obs-chart-tick">{b.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <Legend />
    </div>
  )
}
function Ranking({ rs, onAgent }: { rs: Attempt[]; onAgent: (id: string) => void }) {
  const rows = agents
    .map((a) => ({ ...a, rs: rs.filter((r) => r.agent === a.id) }))
    .filter((a) => a.rs.length)
    .sort((a, b) => total(sumUsage(b.rs)) - total(sumUsage(a.rs)))
  const max = Math.max(...rows.map((a) => total(sumUsage(a.rs))), 1)
  return (
    <div className="obs-ranking">
      {rows.map((a) => (
        <div className="obs-rank-row" key={a.id}>
          <div>
            <button className="obs-link" type="button" onClick={() => onAgent(a.id)}>
              {a.name}
            </button>
            <span className="obs-num">{tokenLabel(a.rs)}</span>
          </div>
          <div className="obs-rank-track">
            <div style={{ width: `${(total(sumUsage(a.rs)) / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
function Overview({
  ts,
  range,
  onPick,
  onAgent,
  onBucket,
}: {
  ts: Task[]
  range: string
  onPick: (t: Task) => void
  onAgent: (id: string) => void
  onBucket: (ts: Task[], title: string) => void
}) {
  const rs = allRuns(ts),
    anomalies = ts.filter((t) => t.status === 'failed' || t.status === 'awaiting_human')
  return (
    <div className="obs-page-stack">
      <MetricStrip ts={ts} />
      <div className="obs-two-column">
        <Card
          title="用量趋势"
          actions={<span className="obs-small obs-muted">点击柱形查看任务</span>}
        >
          <Trend ts={ts} range={range} onBucket={onBucket} />
        </Card>
        <Card
          title="Agent 消耗分布"
          actions={<span className="obs-small obs-muted">全部执行尝试</span>}
        >
          <Ranking rs={rs} onAgent={onAgent} />
        </Card>
      </div>
      {anomalies.length > 0 && (
        <div className="obs-attention">
          <span className="obs-attention-dot">!</span>
          <div>
            <strong>{anomalies.length} 项值得关注</strong>
            <span>
              {' '}
              {anomalies
                .map((t) =>
                  t.status === 'awaiting_human' ? '有任务等待人工处理' : '有任务执行失败',
                )
                .join(' · ')}
            </span>
          </div>
          <Button onClick={() => onBucket(anomalies, '需要关注的任务')}>查看任务</Button>
        </div>
      )}
      <Card
        title="最近任务"
        actions={<span className="obs-small obs-muted">按开始时间 · 点击进入完整追踪</span>}
      >
        <TaskTable ts={[...ts].sort((a, b) => a.ago - b.ago).slice(0, 5)} onPick={onPick} compact />
      </Card>
    </div>
  )
}
function AgentSummary({ rs, onAgent }: { rs: Attempt[]; onAgent: (id: string) => void }) {
  const rows = agents
    .map((a) => ({ ...a, rs: rs.filter((r) => r.agent === a.id) }))
    .filter((a) => a.rs.length)
  return (
    <TableViewport label="任务内 Agent 汇总" minWidth="md">
      <table className="data-table data-table--compact obs-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="obs-num">执行</th>
            <th className="obs-num">Token</th>
            <th>用量构成</th>
            <th className="obs-num">累计占用</th>
            <th className="obs-num">失败消耗</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <button className="obs-link" type="button" onClick={() => onAgent(a.id)}>
                  {a.name}
                </button>
                <div className="obs-muted obs-small">
                  {a.role} · {a.revision}
                </div>
              </td>
              <td className="obs-num">{a.rs.length}</td>
              <td className="obs-num">{tokenLabel(a.rs)}</td>
              <td className="obs-breakdown-cell">
                <Breakdown usage={sumUsage(a.rs)} />
              </td>
              <td className="obs-num">{dur(a.rs.reduce((s, r) => s + r.end - r.start, 0))}</td>
              <td className="obs-num">{tokenLabel(a.rs.filter((r) => r.status === 'failed'))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>此任务汇总（全部尝试）</td>
            <td className="obs-num">{rs.length}</td>
            <td className="obs-num">{tokenLabel(rs)}</td>
            <td>
              <Breakdown usage={sumUsage(rs)} />
            </td>
            <td className="obs-num">{dur(rs.reduce((s, r) => s + r.end - r.start, 0))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </TableViewport>
  )
}
function Attempts({ rs, onSelect }: { rs: Attempt[]; onSelect: (r: Attempt) => void }) {
  return (
    <TableViewport label="每次 Agent 执行明细" minWidth="md">
      <table className="data-table data-table--compact obs-table">
        <thead>
          <tr>
            <th>Agent / 活动</th>
            <th>状态</th>
            <th>回合 / 重试</th>
            <th className="obs-num">Token</th>
            <th className="obs-num">起点 → 终点</th>
            <th className="obs-num">占用</th>
          </tr>
        </thead>
        <tbody>
          {[...rs]
            .sort((a, b) => a.start - b.start)
            .map((r) => (
              <tr key={r.id}>
                <td>
                  <button className="obs-link" type="button" onClick={() => onSelect(r)}>
                    <Name id={r.agent} /> · {r.activity}
                  </button>
                  <div className="obs-small obs-muted">{r.id}</div>
                </td>
                <td>
                  <Status value={r.status} />
                </td>
                <td>
                  第 {r.round} 回合 · {r.retry ? `重试 ${r.retry}` : '首次尝试'}
                </td>
                <td className="obs-num">{tokenLabel([r])}</td>
                <td className="obs-num">
                  {dur(r.start)} → {dur(r.end)}
                </td>
                <td className="obs-num">{dur(r.end - r.start)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </TableViewport>
  )
}
type SpanSelection = { attempt: Attempt; phase?: number }
function SpanDetail({ selection }: { selection: SpanSelection }) {
  const r = selection.attempt,
    phase = selection.phase
  const frac = phase === 0 ? 0.4 : phase === 2 ? 0.6 : 1
  const usage =
    r.usage && phase !== 1
      ? (Object.fromEntries(
          Object.entries(r.usage).map(([k, v]) => [k, Math.round(v * frac)]),
        ) as Usage)
      : null
  const duration =
    (r.end - r.start) * (phase === 0 ? 0.45 : phase === 1 ? 0.2 : phase === 2 ? 0.35 : 1)
  return (
    <div className="obs-page-stack">
      <div className="obs-detail-heading">
        <ResourceIcon name="agent" />
        <h3>
          <Name id={r.agent} />
        </h3>
        <Status value={phase === 0 || phase === 1 ? 'done' : r.status} />
      </div>
      <div className="obs-muted">
        {r.activity} ·{' '}
        {phase === undefined
          ? '执行尝试'
          : ['模型调用 #1', '工具调用 · bash', '模型调用 #2'][phase]}
      </div>
      <div className="obs-detail-metrics">
        <Stat
          label="本段 Token"
          value={
            phase === 1
              ? '不适用'
              : usage
                ? `${r.partial ? '≥ ' : ''}${short(total(usage))}`
                : '未上报'
          }
          hint={
            phase === 1
              ? '工具调用不重复计入父级用量'
              : r.partial
                ? '部分数据，尚未对账'
                : '仅此选择范围'
          }
        />
        <Stat
          label="本段历时"
          value={dur(duration)}
          hint={phase === undefined ? '包含模型及工具等待' : '此调用的包含耗时'}
        />
      </div>
      {usage && (
        <>
          <Breakdown usage={usage} />
          <div className="obs-definition-list">
            {categories.map((c) => (
              <React.Fragment key={c.key}>
                <span>
                  <i className={`obs-swatch obs-${c.key}`} /> {c.label}
                </span>
                <strong>{num(usage[c.key])}</strong>
              </React.Fragment>
            ))}
            <span>推理 Token（输出子集）</span>
            <span>未单独上报</span>
            <span>费用估算 · 示例 人民币 CNY</span>
            <span>{money(cost({ ...r, usage }))}</span>
          </div>
        </>
      )}
      <div className="obs-definition-list">
        <span>模型（虚构样本）</span>
        <span>{models.find((m) => m.id === r.model)?.name}</span>
        <span>技术重试</span>
        <span>{r.retry}</span>
        <span>工作组回合</span>
        <span>{r.round}</span>
        <span>执行 ID</span>
        <code>{r.id}</code>
        <span>来源</span>
        <span>设计演示 fixture</span>
      </div>
      {r.status === 'failed' && (
        <div className="obs-attention">
          <span>!</span>
          <div>
            <strong>工具验证失败</strong>
            <div>此次尝试的已知用量仍计入任务总额。后续重试保留为独立执行记录。</div>
          </div>
        </div>
      )}
      <Card title="关联事件（演示）">
        <ol className="obs-events">
          <li>
            <time>+{dur(r.start)}</time> 开始 {r.activity}
          </li>
          <li>
            <time>+{dur(r.start + (r.end - r.start) * 0.45)}</time> 工具调用 · 检查工作区
          </li>
          <li>
            <time>+{dur(r.end)}</time>{' '}
            {r.status === 'running'
              ? '采集水位，执行仍在继续'
              : r.status === 'failed'
                ? '退出 · validation_failed'
                : `执行${statusNames[r.status]}`}
          </li>
        </ol>
      </Card>
    </div>
  )
}
function Timeline({ task, onSelect }: { task: Task; onSelect: (s: SpanSelection) => void }) {
  const [expanded, setExpanded] = useState<string[]>(['backend'])
  const [zoom, setZoom] = useState('1'),
    [criticalOnly, setCriticalOnly] = useState(false)
  const hasCritical = task.id === mainTask.id
  const max = Math.ceil(task.duration / 60) * 60
  const activeAgents = agents.filter((a) => task.attempts.some((r) => r.agent === a.id))
  const toggle = (id: string) =>
    setExpanded((x) => (x.includes(id) ? x.filter((a) => a !== id) : [...x, id]))
  const ticks = Array.from({ length: 7 }, (_, i) => Math.round((max / 6) * i))
  return (
    <div className="obs-page-stack">
      <div className="obs-toolbar">
        <div className="obs-legend">
          <span>
            <i className="obs-swatch obs-span-model" />
            模型 / Agent 活动
          </span>
          <span>
            <i className="obs-swatch obs-span-tool" />
            工具
          </span>
          <span>
            <i className="obs-swatch obs-span-wait" />
            人工等待
          </span>
          <span>
            <i className="obs-swatch obs-span-failed" />
            失败
          </span>
        </div>
        <div className="obs-inline">
          <Button
            onClick={() =>
              setExpanded(
                expanded.length === activeAgents.length ? [] : activeAgents.map((a) => a.id),
              )
            }
          >
            {expanded.length === activeAgents.length ? '折叠全部' : '展开全部'}
          </Button>
          <Button
            disabled={!hasCritical}
            aria-pressed={criticalOnly}
            onClick={() => setCriticalOnly(!criticalOnly)}
          >
            {criticalOnly ? '显示全部路径' : '突出关键路径'}
          </Button>
          <Segmented
            ariaLabel="时间轴缩放"
            value={zoom}
            onChange={setZoom}
            options={[
              { value: '1', label: '适应' },
              { value: '2', label: '2×' },
              { value: '4', label: '4×' },
            ]}
          />
        </div>
      </div>
      <div
        className="obs-timeline-scroll"
        role="region"
        aria-label="Agent 执行泳道，可横向滚动"
        tabIndex={0}
      >
        <div className="obs-timeline" style={{ minWidth: `${Number(zoom) * 850}px` }}>
          <div className="obs-lane obs-lane-axis">
            <div className="obs-lane-name">Agent / 执行周期</div>
            <div className="obs-axis">
              {ticks.map((t, i) => (
                <span key={t} style={{ left: `${(i / 6) * 100}%` }}>
                  {dur(t)}
                </span>
              ))}
            </div>
            <div className="obs-lane-total">Token</div>
          </div>
          <div className="obs-lane obs-task-lane">
            <div className="obs-lane-name">
              <strong>任务全程</strong>
              <span className="obs-small obs-muted">
                {dur(task.duration)} · {statusNames[task.status]}
              </span>
            </div>
            <div className="obs-track">
              <span
                className="obs-task-outline"
                style={{ width: `${(task.duration / max) * 100}%` }}
              />
              {task.queue > 0 && (
                <span
                  className="obs-queue-mark"
                  style={{ width: `${Math.max((task.queue / max) * 100, 0.4)}%` }}
                  title={`排队 ${dur(task.queue)}`}
                />
              )}
              {task.human > 0 && (
                <span
                  className="obs-human-mark"
                  style={{
                    left: `${((task.id === mainTask.id ? 960 : task.duration - task.human) / max) * 100}%`,
                    width: `${(task.human / max) * 100}%`,
                  }}
                  title={`人工等待 ${dur(task.human)}`}
                >
                  {task.human / task.duration > 0.13 ? '人工等待' : '等待'}
                </span>
              )}
            </div>
            <div className="obs-lane-total">{tokenLabel(task.attempts)}</div>
          </div>
          {activeAgents.map((a) => {
            const rs = task.attempts.filter((r) => r.agent === a.id)
            const isExpanded = expanded.includes(a.id)
            const lanes = rs.some((r, i) =>
              rs.some((o, j) => i !== j && r.start < o.end && o.start < r.end),
            )
              ? rs.map((r) => [r])
              : [rs]
            return (
              <React.Fragment key={a.id}>
                {lanes.map((lane, li) => (
                  <div className="obs-lane" key={li}>
                    <div className="obs-lane-name">
                      <button
                        className="obs-lane-toggle"
                        type="button"
                        aria-expanded={isExpanded}
                        onClick={() => toggle(a.id)}
                      >
                        <span aria-hidden="true">{isExpanded ? '⌄' : '›'}</span>
                        {a.name}
                        {lanes.length > 1 ? ` #${li + 1}` : ''}
                      </button>
                      <span className="obs-small obs-muted">
                        {rs.length} 次执行 · {dur(rs.reduce((s, r) => s + r.end - r.start, 0))} 累计
                      </span>
                    </div>
                    <div className="obs-track">
                      {lane.map((r) => (
                        <button
                          key={r.id}
                          className={`obs-span obs-span-model${r.status === 'failed' ? ' obs-span-failed' : ''}${r.status === 'running' ? ' obs-span-running' : ''}${criticalOnly && !r.critical ? ' obs-dim' : ''}${criticalOnly && r.critical ? ' obs-critical' : ''}`}
                          type="button"
                          style={{
                            left: `${(r.start / max) * 100}%`,
                            width: `${((r.end - r.start) / max) * 100}%`,
                          }}
                          onClick={() => onSelect({ attempt: r })}
                          title={`${r.activity} · ${dur(r.end - r.start)} · ${tokenLabel([r])} Token`}
                          aria-label={`${a.name}，${r.activity}，${statusNames[r.status]}，${dur(r.end - r.start)}，${tokenLabel([r])} Token`}
                        >
                          <span>
                            {r.status === 'failed' ? '× ' : ''}
                            {r.retry ? '重试 ' : ''}
                            {r.activity}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="obs-lane-total">{tokenLabel(rs)}</div>
                  </div>
                ))}
                {isExpanded &&
                  rs.map((r) => (
                    <div
                      className={`obs-lane obs-lane-child${criticalOnly && !r.critical ? ' obs-dim' : ''}`}
                      key={r.id}
                    >
                      <div className="obs-lane-name">
                        <button
                          type="button"
                          className="obs-link"
                          onClick={() => onSelect({ attempt: r })}
                        >
                          {r.retry ? `重试 ${r.retry}` : `回合 ${r.round}`} · {r.activity}
                        </button>
                        <span className="obs-small obs-muted">
                          {models.find((m) => m.id === r.model)?.name}
                        </span>
                      </div>
                      <div className="obs-track">
                        {[0, 1, 2].map((p) => {
                          const fractions = [0, 0.45, 0.65, 1]
                          return (
                            <button
                              key={p}
                              type="button"
                              className={`obs-span ${p === 1 ? 'obs-span-tool' : 'obs-span-model'}${p === 2 && r.status === 'failed' ? ' obs-span-failed' : ''}`}
                              style={{
                                left: `${((r.start + (r.end - r.start) * fractions[p]) / max) * 100}%`,
                                width: `${(((r.end - r.start) * (fractions[p + 1] - fractions[p])) / max) * 100}%`,
                              }}
                              onClick={() => onSelect({ attempt: r, phase: p })}
                              aria-label={`${a.name} ${r.activity} ${['模型调用一', '工具调用', '模型调用二'][p]}`}
                              title={['模型调用 #1', '工具调用 · bash', '模型调用 #2'][p]}
                            >
                              <span>{p === 1 ? '工具' : '模型'}</span>
                            </button>
                          )
                        })}
                      </div>
                      <div className="obs-lane-total obs-muted">{tokenLabel([r])}</div>
                    </div>
                  ))}
              </React.Fragment>
            )
          })}
        </div>
      </div>
      <div className="obs-caption">
        {hasCritical
          ? '关键路径：计划 → 依赖分析 → 回归验证 → 人工等待 → 最终评审 → 交付。'
          : '此样本未提供完整因果依赖，关键路径不可用。'}{' '}
        泳道与子行是同一笔消耗的不同层级。
      </div>
    </div>
  )
}
function TraceDetail({
  task,
  onBack,
  onSelect,
  onAgent,
}: {
  task: Task
  onBack: () => void
  onSelect: (s: SpanSelection) => void
  onAgent: (id: string) => void
}) {
  const [view, setView] = useState('timeline')
  const rs = task.attempts
  return (
    <div className="obs-page-stack">
      <div className="obs-inline">
        <Button onClick={onBack}>← 任务列表</Button>
        <span className="obs-small obs-muted">任务全生命周期 · 含全部尝试</span>
      </div>
      <div className="obs-task-heading">
        <div>
          <div className="obs-eyebrow">
            {task.id} / {task.repo} / {task.source}
          </div>
          <h2>{task.name}</h2>
        </div>
        <Status value={task.status} />
      </div>
      <div className="obs-metrics">
        <Stat
          label="任务总 Token"
          value={tokenLabel(rs)}
          hint={`${new Set(rs.map((r) => r.agent)).size} 个 Agent · ${rs.length} 次执行`}
        />
        <Stat
          label="任务墙钟历时"
          value={dur(task.duration)}
          hint={`排队 ${dur(task.queue)} · 人工等待 ${dur(task.human)}`}
        />
        <Stat
          label="Agent 累计占用"
          value={dur(rs.reduce((s, r) => s + r.end - r.start, 0))}
          hint="并行执行的时长可重叠"
        />
        <Stat
          label="费用估算 · 示例 人民币 CNY"
          value={
            rs.some((r) => r.usage)
              ? `${isPartial(rs) ? '≥ ' : ''}${money(rs.reduce((s, r) => s + cost(r), 0))}`
              : '—'
          }
          hint={`${rs.filter((r) => r.retry > 0).length} 次技术重试 · 失败消耗保留`}
        />
      </div>
      {isPartial(rs) && (
        <div className="obs-attention">
          <span>!</span>
          <div>
            <strong>用量尚不完整</strong>
            <div>
              {rs.filter((r) => r.usage && !r.partial).length}/{rs.length}{' '}
              次执行有完整用量。显示已知下界，未上报值不是零。
            </div>
          </div>
        </div>
      )}
      <Card
        title="执行分析"
        actions={
          <Segmented
            ariaLabel="任务分析视图"
            value={view}
            onChange={setView}
            options={[
              { value: 'timeline', label: '执行泳道' },
              { value: 'agents', label: 'Agent 汇总' },
              { value: 'attempts', label: '执行明细' },
            ]}
          />
        }
      >
        {view === 'timeline' ? (
          <Timeline key={task.id} task={task} onSelect={onSelect} />
        ) : view === 'agents' ? (
          <>
            <AgentSummary rs={rs} onAgent={onAgent} />
            <Legend />
          </>
        ) : (
          <Attempts rs={rs} onSelect={(r) => onSelect({ attempt: r })} />
        )}
      </Card>
    </div>
  )
}
function AgentAnalysis({
  ts,
  selected,
  setSelected,
  onPick,
  onSelect,
}: {
  ts: Task[]
  selected: string | null
  setSelected: (v: string | null) => void
  onPick: (t: Task) => void
  onSelect: (s: SpanSelection) => void
}) {
  const rs = allRuns(ts),
    chosen = agents.find((a) => a.id === selected)
  const [openTask, setOpenTask] = useState<string | null>(null)
  if (chosen) {
    const participating = ts.filter((t) => t.attempts.some((r) => r.agent === chosen.id)),
      ars = rs.filter((r) => r.agent === chosen.id)
    return (
      <div className="obs-page-stack">
        <div>
          <Button onClick={() => setSelected(null)}>← 全部 Agent</Button>
        </div>
        <div className="obs-task-heading">
          <div>
            <div className="obs-eyebrow">
              Agent / {chosen.id} / {chosen.revision}
            </div>
            <h2>{chosen.name}</h2>
            <p className="obs-muted">{chosen.role} · 当前筛选范围内的所有任务贡献</p>
          </div>
        </div>
        <div className="obs-metrics">
          <Stat
            label="参与任务 / 执行次数"
            value={`${participating.length} / ${ars.length}`}
            hint="同任务多次执行只计一个任务"
          />
          <Stat label="累计 Token" value={tokenLabel(ars)} hint="包含失败与重试" />
          <Stat
            label="累计占用"
            value={dur(ars.reduce((n, r) => n + r.end - r.start, 0))}
            hint="每个执行区间之和"
          />
          <Stat
            label="费用估算 · 示例 人民币 CNY"
            value={costLabel(ars)}
            hint="仅已知用量 · 示例费率"
          />
        </div>
        <Card title="每个任务的贡献">
          <div className="obs-agent-contributions">
            {participating.map((t) => {
              const rows = t.attempts.filter((r) => r.agent === chosen.id)
              return (
                <div key={t.id} className="obs-contribution">
                  <div className="obs-toolbar">
                    <div>
                      <button className="obs-link" type="button" onClick={() => onPick(t)}>
                        {t.name}
                      </button>
                      <div className="obs-small obs-muted">
                        {t.repo} · {t.id}
                      </div>
                    </div>
                    <div className="obs-inline">
                      <strong>{tokenLabel(rows)} Token</strong>
                      <span>{rows.length} 次执行</span>
                      <Button
                        aria-expanded={openTask === t.id}
                        onClick={() => setOpenTask(openTask === t.id ? null : t.id)}
                      >
                        {openTask === t.id ? '收起' : '展开执行'}
                      </Button>
                    </div>
                  </div>
                  {openTask === t.id && (
                    <Attempts rs={rows} onSelect={(r) => onSelect({ attempt: r })} />
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    )
  }
  return (
    <div className="obs-page-stack">
      <div className="obs-section-heading">
        <div>
          <h2>每个 Agent 的运行表现</h2>
          <p className="obs-muted">从累计消耗，下钻到单个任务和每次执行。</p>
        </div>
        <StatusChip kind="neutral">按稳定 ID + 版本</StatusChip>
      </div>
      <Card title="Agent 汇总">
        <TableViewport label="跨任务 Agent 统计" minWidth="md">
          <table className="data-table data-table--compact obs-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="obs-num">任务 / 执行</th>
                <th className="obs-num">Token</th>
                <th>用量构成</th>
                <th className="obs-num">累计占用</th>
                <th className="obs-num">失败 / 重试</th>
              </tr>
            </thead>
            <tbody>
              {agents
                .filter((a) => rs.some((r) => r.agent === a.id))
                .sort(
                  (a, b) =>
                    total(sumUsage(rs.filter((r) => r.agent === b.id))) -
                    total(sumUsage(rs.filter((r) => r.agent === a.id))),
                )
                .map((a) => {
                  const ars = rs.filter((r) => r.agent === a.id)
                  return (
                    <tr key={a.id}>
                      <td>
                        <button
                          className="obs-link"
                          type="button"
                          onClick={() => setSelected(a.id)}
                        >
                          {a.name}
                        </button>
                        <div className="obs-small obs-muted">
                          {a.role} · {a.revision}
                        </div>
                      </td>
                      <td className="obs-num">
                        {ts.filter((t) => t.attempts.some((r) => r.agent === a.id)).length} /{' '}
                        {ars.length}
                      </td>
                      <td className="obs-num">{tokenLabel(ars)}</td>
                      <td className="obs-breakdown-cell">
                        <Breakdown usage={sumUsage(ars)} />
                      </td>
                      <td className="obs-num">
                        {dur(ars.reduce((n, r) => n + r.end - r.start, 0))}
                      </td>
                      <td className="obs-num">
                        {ars.filter((r) => r.status === 'failed').length} /{' '}
                        {ars.filter((r) => r.retry > 0).length}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </TableViewport>
        <Legend />
      </Card>
      <Card title="阅读这些指标">
        <div className="obs-explainer">
          <span>参与任务数去重；每次重试、回合和分片保留为独立执行。</span>
          <span>失败不一定由 Agent 质量引起，也可能是工具或环境故障。比较时需要相同工作负载。</span>
        </div>
      </Card>
    </div>
  )
}
function UsageView({
  ts,
  onBucket,
  onPricing,
}: {
  onPricing: () => void
  ts: Task[]
  onBucket: (ts: Task[], title: string) => void
}) {
  const rs = allRuns(ts),
    usage = sumUsage(rs),
    input = usage.input + usage.read + usage.write
  return (
    <div className="obs-page-stack">
      <div className="obs-section-heading">
        <div>
          <h2>Token 去了哪里</h2>
          <p className="obs-muted">生命周期消耗 · 全部尝试 · 已知用量</p>
        </div>
        <StatusChip kind="warn">全部费率仅供演示</StatusChip>
      </div>
      <div className="obs-metrics">
        {categories.map((c) => (
          <Stat
            key={c.key}
            label={c.label}
            value={
              rs.length && rs.every((r) => !r.usage)
                ? '—'
                : `${isPartial(rs) ? '≥ ' : ''}${short(usage[c.key])}`
            }
            hint={
              c.key === 'read'
                ? `已知输入中的占比 ${input ? ((usage.read / input) * 100).toFixed(1) : '—'}%`
                : c.key === 'output'
                  ? '推理 Token 如上报，属于此项子集'
                  : c.key === 'write'
                    ? '缓存创建，不是缓存命中'
                    : '与缓存读、缓存写互斥'
            }
          />
        ))}
      </div>
      <Card title="用量构成">
        <Breakdown usage={usage} />
        <Legend />
        <div className="obs-caption">
          四个互斥桶相加 = {num(total(usage))} 已知 Token。
          {rs.filter((r) => !r.usage || r.partial).length} 次执行不完整，真实消耗可能更高。
        </div>
      </Card>
      <Card
        title="按模型归因"
        actions={<span className="obs-small obs-muted">模型名称与费率均为虚构样本</span>}
      >
        <TableViewport label="模型用量与估算费用" minWidth="md">
          <table className="data-table data-table--compact obs-table">
            <thead>
              <tr>
                <th>模型</th>
                <th className="obs-num">执行次数</th>
                <th className="obs-num">已知 Token</th>
                <th className="obs-num">费用估算</th>
                <th>覆盖 / 定价</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const runs = rs.filter((r) => r.model === m.id)
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.name}</strong>
                      <div className="obs-small obs-muted">演示模型 · CNY-v1</div>
                    </td>
                    <td className="obs-num">{runs.length}</td>
                    <td className="obs-num">{tokenLabel(runs)}</td>
                    <td className="obs-num">{costLabel(runs)}</td>
                    <td>
                      {runs.filter((r) => r.usage && !r.partial).length}/{runs.length} 完整
                    </td>
                    <td>
                      <Button
                        onClick={() =>
                          onBucket(
                            ts.filter((t) => t.attempts.some((r) => r.model === m.id)),
                            `${m.name} 参与的任务（列表显示任务整体用量）`,
                          )
                        }
                      >
                        查看任务
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableViewport>
      </Card>
      <div className="obs-two-column">
        <Card title="失败与重试消耗">
          <div className="obs-definition-list">
            <span>失败尝试的已知用量</span>
            <strong>{tokenLabel(rs.filter((r) => r.status === 'failed'))}</strong>
            <span>重试尝试的已知用量</span>
            <strong>{tokenLabel(rs.filter((r) => r.retry > 0))}</strong>
          </div>
          <p className="obs-caption">
            两个集合可能重叠，不能相加。最终完成不会清除之前失败产生的成本。
          </p>
        </Card>
        <Card title="价格依据">
          <p className="obs-caption">配置入口：工作台设置 → 运行时 → Token 成本。</p>
          <Button onClick={onPricing}>配置 Token 单价</Button>
          <div className="obs-definition-list">
            <span>币种</span>
            <strong>人民币 CNY · 示例</strong>
            <span>价格版本</span>
            <span>CNY-v1</span>
            <span>计算方式</span>
            <span>互斥 Token 桶 × 示例单价</span>
          </div>
          <p className="obs-caption">生产区分厂商上报、价格估算、未定价；本页不是账单。</p>
        </Card>
      </div>
    </div>
  )
}
function Performance({
  ts,
  onPick,
  onBucket,
}: {
  ts: Task[]
  onPick: (t: Task) => void
  onBucket: (ts: Task[], title: string) => void
}) {
  const completed = ts.filter((t) => ['done', 'failed'].includes(t.status)),
    rs = allRuns(ts)
  const bins = [
    { label: '< 5m', min: 0, max: 300 },
    { label: '5–10m', min: 300, max: 600 },
    { label: '10–20m', min: 600, max: 1200 },
    { label: '≥ 20m', min: 1200, max: Infinity },
  ]
  const alerts = ts.flatMap((t) => [
    ...(t.status === 'failed'
      ? [
          {
            task: t,
            label: '任务执行失败',
            desc: `${t.attempts.filter((r) => r.status === 'failed').length} 次失败执行，需要查看原因`,
            kind: 'danger',
          },
        ]
      : []),
    ...(t.human > 3600
      ? [
          {
            task: t,
            label: '人工等待超过 1 小时',
            desc: `已等待 ${dur(t.human)}，等待时间与模型执行分开统计`,
            kind: 'warn',
          },
        ]
      : []),
    ...(t.attempts.some((r) => !r.usage)
      ? [
          {
            task: t,
            label: '执行用量缺失',
            desc: '至少一次执行尚无可确认用量，汇总显示下界',
            kind: 'warn',
          },
        ]
      : []),
    ...(t.attempts.some((r) => r.retry > 0)
      ? [
          {
            task: t,
            label: '发生技术重试',
            desc: `失败尝试消耗 ${tokenLabel(t.attempts.filter((r) => r.status === 'failed'))} Token`,
            kind: 'warn',
          },
        ]
      : []),
  ])
  return (
    <div className="obs-page-stack">
      <div className="obs-section-heading">
        <div>
          <h2>慢在哪里，为什么重试</h2>
          <p className="obs-muted">完成耗时只取 done / failed；运行中与人工等待任务单独观察。</p>
        </div>
      </div>
      <div className="obs-metrics">
        <Stat
          label="P50 完成历时"
          value={
            completed.length
              ? dur(
                  percentile(
                    completed.map((t) => t.duration),
                    0.5,
                  )!,
                )
              : '—'
          }
          hint={`n=${completed.length} · 非 Agent 累计占用`}
        />
        <Stat
          label="技术重试次数"
          value={`${rs.filter((r) => r.retry > 0).length}`}
          hint="回合与返工不算技术重试"
        />
        <Stat
          label="等待人工的任务"
          value={`${ts.filter((t) => t.status === 'awaiting_human').length}`}
          hint="不混入已完成任务的耗时分布"
        />
        <Stat
          label="用量完整率"
          value={`${rs.length ? ((rs.filter((r) => r.usage && !r.partial).length / rs.length) * 100).toFixed(1) : '—'}%`}
          hint="已完整上报执行 / 全部 Agent 执行"
        />
      </div>
      <div className="obs-two-column">
        <Card title="完成历时分布">
          <div className="obs-histogram">
            {bins.map((b) => {
              const rows = completed.filter((t) => t.duration >= b.min && t.duration < b.max)
              return (
                <button
                  key={b.label}
                  type="button"
                  className="obs-hist-row"
                  onClick={() => onBucket(rows, `${b.label} 完成的任务`)}
                  aria-label={`${b.label}，${rows.length} 个任务，查看`}
                >
                  <span>{b.label}</span>
                  <span className="obs-hist-track">
                    <i
                      style={{ width: `${(rows.length / Math.max(completed.length, 1)) * 100}%` }}
                    />
                  </span>
                  <strong>{rows.length}</strong>
                </button>
              )
            })}
          </div>
          <p className="obs-caption">样本 n={completed.length} · 点击区间查看任务。</p>
        </Card>
        <Card title="采集能力与状态">
          <div className="obs-definition-list">
            <span>任务 / 尝试用量</span>
            <span>
              {rs.filter((r) => r.usage && !r.partial).length}/{rs.length} 完整
            </span>
            <span>模型 / 工具细分</span>
            <span>此原型为合成样本</span>
            <span>首 Token 延迟 / 推理用量</span>
            <span>未提供，显示 —</span>
            <span>最后观测水位</span>
            <span>09-28 15:36:00 +08:00</span>
          </div>
        </Card>
      </div>
      <Card
        title={`异常与关注 · ${alerts.length}`}
        actions={<StatusChip kind="neutral">规则预览 · 未发送通知</StatusChip>}
      >
        {alerts.length ? (
          <div className="obs-alert-list">
            {alerts.map((a, i) => (
              <div className="obs-alert-row" key={i}>
                <StatusChip size="sm" kind={a.kind as 'warn' | 'danger'}>
                  {a.kind === 'danger' ? '失败' : '关注'}
                </StatusChip>
                <div>
                  <strong>{a.label}</strong>
                  <div className="obs-small obs-muted">
                    {a.task.name} · {a.desc}
                  </div>
                </div>
                <Button onClick={() => onPick(a.task)}>定位任务</Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="当前范围没有命中规则" size="compact" />
        )}
      </Card>
    </div>
  )
}
function App() {
  const params = new URLSearchParams(location.search)
  const [tab, setTab] = useState(
    params.get('tab') && tabDefs.some((t) => t.key === params.get('tab'))
      ? params.get('tab')!
      : 'overview',
  )
  const [repo, setRepo] = useState(params.get('repo') ?? 'all'),
    [range, setRange] = useState(params.get('range') === '168' ? '168' : '24'),
    [source, setSource] = useState(params.get('source') ?? 'all')
  const [query, setQuery] = useState(params.get('query') ?? ''),
    [sort, setSort] = useState(params.get('sort') ?? 'recent')
  const [task, setTask] = useState<Task | null>(
      tasks.find((t) => t.id === params.get('task')) ?? null,
    ),
    [agent, setAgent] = useState<string | null>(params.get('agent'))
  const [selection, setSelection] = useState<SpanSelection | null>(null),
    [bucket, setBucket] = useState<{ tasks: Task[]; title: string } | null>(null),
    [definitions, setDefinitions] = useState(false)
  const [pricing, setPricing] = useState(params.get('settings') === 'runtime-pricing')
  const [dark, setDark] = useState(false),
    [notice, setNotice] = useState(''),
    [menu, setMenu] = useState(false)
  const mainRef = useRef<HTMLElement>(null),
    definitionsRef = useRef<HTMLButtonElement>(null)
  const filtered = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.ago < Number(range) &&
          (repo === 'all' || t.repo === repo) &&
          (source === 'all' || t.source === source),
      ),
    [repo, range, source],
  )
  const shown = filtered
    .filter((t) => `${t.name} ${t.id}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === 'tokens'
        ? total(sumUsage(b.attempts)) - total(sumUsage(a.attempts))
        : sort === 'duration'
          ? b.duration - a.duration
          : a.ago - b.ago,
    )
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])
  useEffect(() => {
    const p = new URLSearchParams({ tab, repo, range })
    if (pricing) p.set('settings', 'runtime-pricing')
    if (tab === 'traces' && task) p.set('task', task.id)
    if (source !== 'all') p.set('source', source)
    if (query) p.set('query', query)
    if (sort !== 'recent') p.set('sort', sort)
    if (tab === 'agents' && agent) p.set('agent', agent)
    history.replaceState(null, '', `?${p}`)
  }, [tab, repo, range, task, source, query, sort, agent, pricing])
  const pickTask = (t: Task) => {
    setTask(t)
    setTab('traces')
    setBucket(null)
    mainRef.current?.scrollTo({ top: 0 })
  }
  const pickAgent = (id: string) => {
    setAgent(id)
    setTab('agents')
    mainRef.current?.scrollTo({ top: 0 })
  }
  const changeTab = (v: string) => {
    setTab(v)
    setMenu(false)
    mainRef.current?.scrollTo({ top: 0 })
  }
  const changeFilter = (fn: (s: string) => void) => (v: string) => {
    fn(v)
    setTask(null)
    setAgent(null)
  }
  const bucketOpen = (ts: Task[], title: string) => setBucket({ tasks: ts, title })
  const exportCsv = () => {
    const exportTasks = tab === 'traces' && task ? [task] : tab === 'traces' ? shown : filtered
    const rows = [
      [
        'task_id',
        'task',
        'repo',
        'status',
        'known_tokens',
        'usage_complete',
        'duration_seconds',
        'scope',
      ],
      ...exportTasks.map((t) => [
        t.id,
        t.name,
        t.repo,
        t.status,
        t.attempts.every((r) => !r.usage) ? '' : String(total(sumUsage(t.attempts))),
        String(!isPartial(t.attempts)),
        String(t.duration),
        'task_lifetime_all_attempts',
      ]),
    ]
    const csv =
      '\uFEFF' +
      rows.map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'observability-demo-tasks.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice(`已导出 ${exportTasks.length} 条合成任务，包含数据完整性标记。`)
  }
  const navGroups: { title: string; items: [string, ResourceIconKey][] }[] = [
    {
      title: '能力资源',
      items: [
        ['代理', 'agent'],
        ['技能', 'skill'],
        ['MCP', 'mcp'],
        ['插件', 'plugin'],
      ],
    },
    {
      title: '编排',
      items: [
        ['工作流', 'workflow'],
        ['工作组', 'workgroup'],
        ['意图构建', 'intent'],
      ],
    },
    { title: '数字员工', items: [['数字员工', 'digital-employee']] },
    {
      title: '运行与仓库',
      items: [
        ['任务', 'task'],
        ['运行观测与统计', 'workflow'],
        ['定时任务', 'schedule'],
        ['事件中心', 'webhook'],
        ['远端仓', 'repo'],
      ],
    },
    { title: '知识', items: [['记忆', 'memory']] },
  ]
  return (
    <div className="app-shell obs-shell">
      <aside className={`sidebar obs-sidebar${menu ? ' obs-mobile-open' : ''}`}>
        <div className="sidebar__brand">
          <span className="obs-brand-mark">AW</span>
          <strong>Agent Workflow</strong>
        </div>
        <nav className="sidebar__nav" aria-label="应用导航示意">
          <div className="nav-item obs-context-nav">
            <ResourceIcon name="home" />
            首页
          </div>
          {navGroups.map((g) => (
            <div key={g.title} className="nav-group">
              <div className="nav-group__header">{g.title}</div>
              <div className="nav-group__items">
                {g.items.map(([label, icon]) =>
                  label === '运行观测与统计' ? (
                    <button
                      key={label}
                      type="button"
                      className="nav-item obs-active"
                      aria-current="page"
                      onClick={() => {
                        setTab('overview')
                        setMenu(false)
                      }}
                    >
                      <ResourceIcon name={icon} />
                      <span>{label}</span>
                    </button>
                  ) : (
                    <div key={label} className="nav-item obs-context-nav">
                      <ResourceIcon name={icon} />
                      <span>{label}</span>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </nav>
        <div className="obs-sidebar-bottom">
          <Button
            onClick={() => {
              setPricing(true)
              setMenu(false)
            }}
          >
            工作台设置 · 运行时
          </Button>
          <StatusChip kind="neutral" size="sm">
            设计原型 · RFC-371
          </StatusChip>
          <span className="obs-small obs-muted">导航示意 / 合成数据</span>
        </div>
      </aside>
      <main className="content obs-content" ref={mainRef}>
        <div className="obs-topline">
          <div className="obs-inline">
            <button
              type="button"
              className="btn btn--sm obs-mobile-menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              导航
            </button>
            <span>
              运行与仓库 <span className="obs-muted"> / </span> 运行观测与统计
            </span>
          </div>
          <div className="obs-inline">
            <span className="obs-demo-dot" />
            <span className="obs-small obs-muted">演示快照 · 09-28 15:36</span>
            <Button
              onClick={() => setDark(!dark)}
              aria-label={dark ? '切换浅色主题' : '切换深色主题'}
            >
              {dark ? '浅色' : '深色'}
            </Button>
          </div>
        </div>
        <div className="page">
          <div className="page__header page__header--row obs-header">
            <div>
              <h1 className="page__title">运行观测与统计</h1>
              <p className="page__subtitle">看清每次任务的消耗、协作与执行过程。</p>
            </div>
            <div className="page__actions">
              <button
                ref={definitionsRef}
                type="button"
                className="btn btn--sm"
                onClick={() => setDefinitions(true)}
              >
                指标口径
              </button>
              <Button onClick={exportCsv}>
                {tab === 'traces' && task ? '导出此任务 CSV' : '导出任务 CSV'}
              </Button>
            </div>
          </div>
          <div className="obs-filterbar">
            <div className="obs-inline obs-filter-fields">
              <Select
                ariaLabel="时间范围"
                value={range}
                onChange={changeFilter(setRange)}
                options={[
                  { value: '24', label: '最近 24 小时' },
                  { value: '168', label: '最近 7 天' },
                ]}
              />
              <Select
                ariaLabel="仓库范围"
                value={repo}
                onChange={changeFilter(setRepo)}
                options={[
                  { value: 'all', label: '全部仓库' },
                  { value: 'agent-workflow', label: 'agent-workflow' },
                  { value: 'CrewStation', label: 'CrewStation' },
                ]}
              />
              <Select
                ariaLabel="任务来源"
                value={source}
                onChange={changeFilter(setSource)}
                options={[
                  { value: 'all', label: '全部任务来源' },
                  ...['单 Agent', '工作流', '工作组'].map((v) => ({ value: v, label: v })),
                ]}
              />
            </div>
            <span className="obs-small obs-muted">我的可见任务 · UTC+08:00 · 生命周期口径</span>
          </div>
          <TabBar
            tabs={tabDefs}
            active={tab}
            onSelect={changeTab}
            ariaLabel="运行观测与统计视图"
            idPrefix="obs-main"
          />
          <div
            className="obs-tab-content"
            id={`obs-main-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`obs-main-tab-${tab}`}
          >
            {tab === 'overview' && (
              <Overview
                ts={filtered}
                range={range}
                onPick={pickTask}
                onAgent={pickAgent}
                onBucket={bucketOpen}
              />
            )}
            {tab === 'traces' &&
              (task ? (
                <TraceDetail
                  key={task.id}
                  task={task}
                  onBack={() => setTask(null)}
                  onSelect={setSelection}
                  onAgent={pickAgent}
                />
              ) : (
                <div className="obs-page-stack">
                  <div className="obs-section-heading">
                    <div>
                      <h2>任务追踪</h2>
                      <p className="obs-muted">每个任务的整体用量，都可以追溯到单次执行。</p>
                    </div>
                    <StatusChip kind="neutral">{shown.length} 个任务</StatusChip>
                  </div>
                  <div className="obs-toolbar">
                    <div className="obs-search">
                      <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="搜索任务名称或 ID"
                        aria-label="搜索任务名称或 ID"
                      />
                    </div>
                    <Select
                      ariaLabel="任务排序"
                      value={sort}
                      onChange={setSort}
                      options={[
                        { value: 'recent', label: '最近开始' },
                        { value: 'tokens', label: 'Token 从高到低' },
                        { value: 'duration', label: '历时从长到短' },
                      ]}
                    />
                  </div>
                  <Card>
                    <TaskTable ts={shown} onPick={pickTask} />
                  </Card>
                </div>
              ))}
            {tab === 'agents' && (
              <AgentAnalysis
                ts={filtered}
                selected={agent}
                setSelected={setAgent}
                onPick={pickTask}
                onSelect={setSelection}
              />
            )}
            {tab === 'usage' && (
              <UsageView ts={filtered} onBucket={bucketOpen} onPricing={() => setPricing(true)} />
            )}
            {tab === 'performance' && (
              <Performance ts={filtered} onPick={pickTask} onBucket={bucketOpen} />
            )}
          </div>
          <footer className="obs-footer">
            <span>合成演示数据 · 未接入真实运行 · 示例价格不代表账单</span>
            <span>RFC-371 · 全景设计 / Draft</span>
          </footer>
          <div className="obs-announcement" role="status" aria-live="polite">
            {notice}
          </div>
        </div>
      </main>
      <RuntimePricing open={pricing} onClose={() => setPricing(false)} />
      <Dialog
        open={selection !== null}
        onClose={() => setSelection(null)}
        title="执行片段详情"
        size="lg"
      >
        {selection && <SpanDetail selection={selection} />}
      </Dialog>
      <Dialog
        open={bucket !== null}
        onClose={() => setBucket(null)}
        title={bucket?.title ?? '关联任务'}
        size="lg"
      >
        {bucket && <TaskTable ts={bucket.tasks} onPick={pickTask} compact />}
      </Dialog>
      <Dialog
        open={definitions}
        onClose={() => setDefinitions(false)}
        title="指标口径与数据说明"
        size="lg"
        triggerRef={definitionsRef}
      >
        <div className="obs-page-stack">
          <p>
            当前原型按开始时间选择任务，统计所选任务的完整生命周期。真实产品另提供“窗口内发生的用量”口径，跨日任务不重复计账。
          </p>
          <div className="obs-definition-list">
            <strong>Token 总量</strong>
            <span>非缓存输入 + 缓存读取 + 缓存写入 + 输出；推理是输出子集。</span>
            <strong>任务墙钟历时</strong>
            <span>任务创建至结束（或当前水位），包含排队与人工等待。</span>
            <strong>Agent 累计占用</strong>
            <span>所有叶子执行尝试的时间之和；并行时可以超过任务墙钟。</span>
            <strong>成功率</strong>
            <span>done / (done + failed)，取消、中断和未结束另列。</span>
            <strong>≥ 与 —</strong>
            <span>≥ 表示已知下界；— 表示没有可信用量。未知不能算作零。</span>
            <strong>失败与重试</strong>
            <span>实际消耗全部保留；工作组回合不等于技术重试。</span>
            <strong>权限</strong>
            <span>正式产品先按任务可见性过滤再聚合；本原型只含虚构数据。</span>
          </div>
          <Card title="演示场景">
            <p>
              认证重构任务：6 个 Agent、8 次执行、206,000 Token；任务墙钟 20m42s，累计占用
              35m47s，人工等待 2m，技术重试 1 次。
            </p>
          </Card>
        </div>
      </Dialog>
    </div>
  )
}
createRoot(document.getElementById('observability-demo')!).render(<App />)
