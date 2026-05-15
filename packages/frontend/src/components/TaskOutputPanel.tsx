// Top-of-task-detail "outputs" panel (P-2-11).
//
// Resolves each output-node port via the workflow snapshot + node-run-outputs
// table: for each declared port `{name, bind: {nodeId, portName}}`, walk the
// most-recent run of `bind.nodeId` and pull its `bind.portName` value from
// the task's outputs array.

import type { NodeRun, NodeRunOutput, Task } from '@agent-workflow/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  task: Task
  runs: NodeRun[]
  outputs: NodeRunOutput[]
}

interface DeclaredPort {
  /** Output-node's port name (shown as the card title). */
  name: string
  /** Source node id. */
  nodeId: string
  /** Source port name on the source node. */
  portName: string
}

export function TaskOutputPanel({ task, runs, outputs }: Props) {
  const { t } = useTranslation()
  const ports = collectPorts(task.workflowSnapshot)
  if (ports.length === 0) {
    return null
  }
  const valueByRunPort = new Map<string, string>()
  for (const o of outputs) valueByRunPort.set(`${o.nodeRunId}:${o.port}`, o.value)

  // Pick the latest run per nodeId (highest startedAt or last in list).
  const latestRunByNodeId = new Map<string, NodeRun>()
  for (const r of runs) {
    const prev = latestRunByNodeId.get(r.nodeId)
    if (prev === undefined || (r.startedAt ?? 0) >= (prev.startedAt ?? 0)) {
      latestRunByNodeId.set(r.nodeId, r)
    }
  }

  return (
    <section className="task-outputs">
      <h2>{t('taskOutputs.section')}</h2>
      <div className="task-outputs__grid">
        {ports.map((p, i) => {
          const run = latestRunByNodeId.get(p.nodeId)
          const value =
            run === undefined ? null : (valueByRunPort.get(`${run.id}:${p.portName}`) ?? null)
          return <OutputCard key={`${p.name}-${i}`} port={p} value={value} />
        })}
      </div>
    </section>
  )
}

interface CardProps {
  port: DeclaredPort
  value: string | null
}

function OutputCard({ port, value }: CardProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    if (value === null) return
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <article className="task-output-card">
      <header className="task-output-card__header">
        <div>
          <div className="task-output-card__name">{port.name}</div>
          <div className="task-output-card__bind">
            ←{' '}
            <code>
              {port.nodeId}.{port.portName}
            </code>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={handleCopy}
          disabled={value === null}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </header>
      <pre className="task-output-card__body">
        {value === null ? (
          <span className="muted">{t('taskOutputs.pending')}</span>
        ) : value === '' ? (
          <span className="muted">{t('common.empty')}</span>
        ) : (
          value
        )}
      </pre>
    </article>
  )
}

export function collectPorts(snapshot: unknown): DeclaredPort[] {
  if (typeof snapshot !== 'object' || snapshot === null) return []
  const rec = snapshot as Record<string, unknown>
  const nodes = Array.isArray(rec.nodes) ? rec.nodes : []
  const out: DeclaredPort[] = []
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const nr = n as Record<string, unknown>
    if (nr.kind !== 'output') continue
    const ports = Array.isArray(nr.ports) ? nr.ports : []
    for (const p of ports) {
      if (typeof p !== 'object' || p === null) continue
      const pr = p as Record<string, unknown>
      if (typeof pr.name !== 'string') continue
      const bind = pr.bind
      if (typeof bind !== 'object' || bind === null) continue
      const br = bind as Record<string, unknown>
      if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
      out.push({ name: pr.name, nodeId: br.nodeId, portName: br.portName })
    }
  }
  // Also accept workflow-level `outputs` bindings (design.md §5).
  if (Array.isArray(rec.outputs)) {
    for (const o of rec.outputs) {
      if (typeof o !== 'object' || o === null) continue
      const or = o as Record<string, unknown>
      const bind = or.bind
      if (typeof or.name !== 'string') continue
      if (typeof bind !== 'object' || bind === null) continue
      const br = bind as Record<string, unknown>
      if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
      out.push({ name: or.name, nodeId: br.nodeId, portName: br.portName })
    }
  }
  return out
}
