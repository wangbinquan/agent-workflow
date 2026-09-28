import { useState } from 'react'
import { Card } from '../../../packages/frontend/src/components/Card'
import { Dialog } from '../../../packages/frontend/src/components/Dialog'
import { Segmented } from '../../../packages/frontend/src/components/Segmented'
import { Select } from '../../../packages/frontend/src/components/Select'
import { StatusChip } from '../../../packages/frontend/src/components/StatusChip'
import { TableViewport } from '../../../packages/frontend/src/components/TableViewport'
import { cost, dur, mainTask, money, num, sumUsage, total } from './fixture'

export type DeploymentMode = 'standalone' | 'crewstation'
export const platformScenes = [
  { value: 'ready', label: '同步正常 · 已定价' },
  { value: 'offline', label: '平台离线 · 保留历史' },
  { value: 'initial', label: '首次同步 · 快照未到齐' },
  { value: 'pending', label: '用量已到 · 估值待回传' },
  { value: 'unpriced', label: '实际模型未定价' },
  { value: 'hidden', label: '项目未开放费用' },
] as const
export type PlatformScene = (typeof platformScenes)[number]['value']

// Explicit synthetic platform response. Never derive this value from AW tariffs.
const platformSample = { amount: '1.030125', version: 'CS-CNY-007', asOf: '09-28 15:36:00' }
const sceneText: Record<PlatformScene, { title: string; detail: string; money: string }> = {
  ready: {
    title: '平台数据已同步',
    detail: '当前用量与费用来自同一份平台快照，可按任务和 Agent 逐层核对。',
    money: `¥${platformSample.amount}`,
  },
  offline: {
    title: '平台连接中断',
    detail: '展示 15:32:00 保存的快照；重连后继续同步。此时金额不会因 AW 本地单价变更而变化。',
    money: `¥${platformSample.amount}`,
  },
  initial: {
    title: '正在获取首次完整快照',
    detail: '执行信息已知，用量尚未到齐。快照完整后再显示总量，当前显示“—”。',
    money: '—',
  },
  pending: {
    title: '用量已同步，费用待回传',
    detail: '费用可以晚于用量到达；补齐费用时，Token 不会再次增加。',
    money: '—',
  },
  unpriced: {
    title: '平台尚未匹配到价格版本',
    detail: '由 CS 管理员为实际使用的模型维护人民币单价；当前保留完整用量和未定价原因。',
    money: '—',
  },
  hidden: {
    title: '此项目未开放费用展示',
    detail: '可以查看 Token 和执行历时；平台未返回金额和价格版本，费用显示“—”。',
    money: '—',
  },
}

export function DeploymentModes({
  mode,
  onMode,
  scene,
  onScene,
  onPricing,
  onTimeline,
}: {
  mode: DeploymentMode
  onMode: (value: DeploymentMode) => void
  scene: PlatformScene
  onScene: (value: PlatformScene) => void
  onPricing: () => void
  onTimeline: () => void
}) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const hosted = mode === 'crewstation',
    state = sceneText[scene]
  const hasUsage = !hosted || scene !== 'initial'
  const hasAmount = !hosted || scene === 'ready' || scene === 'offline'
  const amount = hosted ? state.money : money(mainTask.attempts.reduce((n, r) => n + cost(r), 0))
  const priceVersion = hasAmount ? (hosted ? platformSample.version : 'AW-CNY-v1') : '—'
  return (
    <div className="obs-page-stack">
      <div className="obs-section-heading">
        <div>
          <h2>相同任务，两种观测来源</h2>
          <p className="obs-muted">独立部署与 CS 托管部署对照 · 使用同一合成任务演示</p>
        </div>
        <Segmented<DeploymentMode>
          ariaLabel="部署方式演示"
          value={mode}
          onChange={onMode}
          options={[
            { value: 'standalone', label: '独立 AW' },
            { value: 'crewstation', label: 'CS 托管 AW' },
          ]}
        />
      </div>
      <Card
        title={hosted ? 'CrewStation · 工程平台项目' : '独立 AW · 本地运行时'}
        actions={
          hosted ? (
            <Select<PlatformScene>
              ariaLabel="平台状态演示"
              value={scene}
              onChange={onScene}
              options={platformScenes}
            />
          ) : (
            <StatusChip kind="success" withDot>
              本地采集正常
            </StatusChip>
          )
        }
      >
        <div className="obs-page-stack" role="status" aria-live="polite">
          <div className="obs-inline">
            <StatusChip kind={hosted && scene !== 'ready' ? 'warn' : 'success'}>
              {hosted ? state.title : '用量与人民币价目表由 AW 管理'}
            </StatusChip>
            <span className="obs-small obs-muted">
              数据时间：
              {hosted && scene === 'initial'
                ? '等待快照'
                : hosted && scene === 'offline'
                  ? '09-28 15:32:00'
                  : platformSample.asOf}
            </span>
          </div>
          <p>
            {hosted
              ? state.detail
              : '每次执行使用受理时的价格版本，按实际模型匹配单价。独立 AW 无需连接 CrewStation。'}
          </p>
        </div>
      </Card>
      <div className="obs-metrics">
        {[
          [
            '任务 Token',
            hasUsage ? num(total(sumUsage(mainTask.attempts))) : '—',
            hasUsage ? '四个互斥用量桶 · 含失败与重试' : '尚无完整平台快照',
          ],
          [
            'Agent / 执行次数',
            `${new Set(mainTask.attempts.map((r) => r.agent)).size} / ${mainTask.attempts.length}`,
            '按受理时的 Agent 身份归因',
          ],
          ['任务墙钟历时', dur(mainTask.duration), '与部署方式无关的统一时间口径'],
          [
            '人民币费用估算',
            amount,
            hosted
              ? hasAmount
                ? '平台回传的执行费用 · 示例'
                : state.title
              : 'AW 冻结价目表 · 示例',
          ],
        ].map(([label, value, hint]) => (
          <Card className="obs-stat" key={label}>
            <span className="obs-muted">{label}</span>
            <strong>{value}</strong>
            <span className="obs-muted obs-small">{hint}</span>
          </Card>
        ))}
      </div>
      <Card
        title="单价在哪里配置"
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={hosted ? () => setSourceOpen(true) : onPricing}
          >
            {hosted ? '查看费用来源示例' : '配置 AW 运行时单价'}
          </button>
        }
      >
        <div className="obs-definition-list">
          <strong>管理入口</strong>
          <span>
            {hosted
              ? 'CrewStation → 系统管理 → 算力档位 → Token 成本'
              : 'AW → 工作台设置 → 运行时 → Token 成本'}
          </span>
          <strong>价格归属</strong>
          <span>
            {hosted
              ? 'CS 管理员维护平台算力档位的人民币价格；AW 展示平台返回的费用。'
              : 'AW 管理员按运行时注册项、provider、实际模型及计价条件维护价格。'}
          </span>
          <strong>单位与版本</strong>
          <span>
            元 / 百万 Token · 本次执行价格版本 {priceVersion} · 变更单价只对之后受理的执行生效。
          </span>
          <strong>历史费用</strong>
          <span>
            {hosted
              ? '保留 CS 估值版本与最后同步时间；平台费用不可用时显示原因。'
              : '保留原受理价格版本；历史重算另建估值版本。'}
          </span>
        </div>
      </Card>
      <Card title="两种部署共用统计口径">
        <TableViewport>
          <table className="data-table data-table--compact obs-table">
            <thead>
              <tr>
                <th>观测能力</th>
                <th>独立 AW</th>
                <th>CS 托管 AW</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['用量来源', '本地运行时的真实用量记录', 'CS 已持久化的执行观测'],
                ['人民币费用', '受理时冻结的 AW 单价版本', 'CS 授权回传的人民币估值'],
                ['任务与 Agent', '任务 → Agent → 每次执行', '同样逐层展示，保留平台执行归属'],
                ['执行泳道', '并行区间、失败尝试、重试与等待', '相同时间口径，额外标示同步状态'],
                ['断开 CS', '独立工作，不依赖平台连接', '保留已同步快照，显示数据时间与缺口'],
                ['未定价 / 无金额', '—，保留原因及已知 Token', '—，保留平台原因及已知 Token'],
              ].map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      </Card>
      <Card
        title="CS 两级观测与 AW 的关系"
        actions={
          <button type="button" className="btn btn--sm" onClick={onTimeline}>
            查看共用泳道示例
          </button>
        }
      >
        <div className="obs-definition-list">
          <strong>系统管理级</strong>
          <span>全平台项目、算力档位、运行时及资源消耗；维护人民币单价和价格版本。</span>
          <strong>项目级</strong>
          <span>当前项目的任务、Agent 和执行消耗；按平台开放范围展示人民币费用。</span>
          <strong>AW 业务视角</strong>
          <span>
            工作流 / 工作组 → 任务 → Agent → 执行尝试。与 CS
            是同一笔用量的不同视角，汇总时只计一次。
          </span>
        </div>
      </Card>
      <Dialog
        open={sourceOpen && hosted}
        onClose={() => setSourceOpen(false)}
        title="平台费用来源 · 合成示例"
        size="md"
      >
        <div className="obs-page-stack">
          <p>此处展示 AW 可读取的平台费用信息；人民币单价由 CS 的算力档位管理页维护。</p>
          <div className="obs-definition-list">
            <strong>来源</strong>
            <span>CrewStation / 华东平台 / 工程平台项目</span>
            <strong>费用状态</strong>
            <span>{state.title}</span>
            <strong>人民币金额</strong>
            <span>{state.money}</span>
            <strong>价格版本</strong>
            <span>{priceVersion}</span>
            <strong>用量覆盖</strong>
            <span>{hasUsage ? '8 / 8 次执行 · Token 只计入一次' : '等待首次完整快照'}</span>
            <strong>同步时间</strong>
            <span>
              {scene === 'initial'
                ? '—'
                : scene === 'offline'
                  ? '09-28 15:32:00（历史快照）'
                  : platformSample.asOf}
            </span>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
