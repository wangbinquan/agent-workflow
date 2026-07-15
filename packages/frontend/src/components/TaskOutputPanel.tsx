// Top-of-task-detail "outputs" panel (P-2-11; redesigned in RFC-072).
//
// Resolves each output-node port via the workflow snapshot + node-run-outputs
// table: for each declared port `{name, bind: {nodeId, portName}}`, walk the
// most-recent run of `bind.nodeId` and pull its `bind.portName` value (and
// resolved kind) from the task's outputs array.
//
// RFC-072 layout: a two-pane browser mirroring the RFC-065 worktree-files tab —
// left is the list of declared output ports (selectable), right is the selected
// port's full-height detail (value + Copy + Download-for-file-kinds).

import type { NodeRun, NodeRunOutput, Task } from '@agent-workflow/shared'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { copyText } from '@/lib/clipboard'
import {
  buildPreviewTarget,
  isMarkdownPreviewable,
  type PreviewSource,
} from '@/lib/markdown-preview'
import { isFileOutputKind, isSingleLinePath } from '@/lib/output-port'
import { downloadPortArtifact, downloadWorktreeFile } from '@/lib/worktree-download'

interface Props {
  task: Task
  runs: NodeRun[]
  outputs: NodeRunOutput[]
}

interface DeclaredPort {
  /** Output-node's port name (shown as the list/title). */
  name: string
  /** Source node id. */
  nodeId: string
  /** Source port name on the source node. */
  portName: string
}

interface ResolvedPort {
  port: DeclaredPort
  value: string | null
  kind: string | null
  /** Source node_run id (latest run of the bound node) — for inline-md preview. */
  runId: string | null
}

export function TaskOutputPanel({ task, runs, outputs }: Props) {
  const { t } = useTranslation()
  const [selectedIndex, setSelectedIndex] = useState(0)

  const ports = collectPorts(task.workflowSnapshot)
  if (ports.length === 0) {
    return null
  }

  const valueByRunPort = new Map<string, string>()
  const kindByRunPort = new Map<string, string | null>()
  for (const o of outputs) {
    valueByRunPort.set(`${o.nodeRunId}:${o.port}`, o.value)
    kindByRunPort.set(`${o.nodeRunId}:${o.port}`, o.kind ?? null)
  }

  // Pick the latest run per nodeId (highest startedAt or last in list).
  const latestRunByNodeId = new Map<string, NodeRun>()
  for (const r of runs) {
    const prev = latestRunByNodeId.get(r.nodeId)
    if (prev === undefined || (r.startedAt ?? 0) >= (prev.startedAt ?? 0)) {
      latestRunByNodeId.set(r.nodeId, r)
    }
  }

  const resolved: ResolvedPort[] = ports.map((port) => {
    const run = latestRunByNodeId.get(port.nodeId)
    const key = run === undefined ? null : `${run.id}:${port.portName}`
    return {
      port,
      value: key === null ? null : (valueByRunPort.get(key) ?? null),
      kind: key === null ? null : (kindByRunPort.get(key) ?? null),
      runId: run?.id ?? null,
    }
  })

  // Clamp: ports can change between renders (live updates) — never index past
  // the end.
  const idx = Math.min(selectedIndex, resolved.length - 1)
  const selected = resolved[idx]

  return (
    <section className="task-outputs">
      <h2>{t('taskOutputs.section')}</h2>
      <div className="task-outputs-panel" data-testid="task-outputs-panel">
        <div
          className="task-outputs-panel__list"
          role="listbox"
          aria-label={t('taskOutputs.section')}
        >
          {resolved.map((r, i) => (
            <button
              key={`${r.port.name}-${i}`}
              type="button"
              role="option"
              aria-selected={i === idx}
              className={'task-outputs-panel__option' + (i === idx ? ' is-selected' : '')}
              onClick={() => setSelectedIndex(i)}
              data-testid={`task-output-option-${i}`}
            >
              <span className="task-outputs-panel__option-name">{r.port.name}</span>
              <span className="task-outputs-panel__option-bind">
                {r.port.nodeId}.{r.port.portName}
              </span>
            </button>
          ))}
        </div>
        <div className="task-outputs-panel__detail">
          {selected !== undefined && (
            <OutputDetail
              key={`${selected.port.name}-${idx}`}
              taskId={task.id}
              port={selected.port}
              value={selected.value}
              kind={selected.kind}
              sourceRunId={selected.runId}
            />
          )}
        </div>
      </div>
    </section>
  )
}

interface DetailProps {
  taskId: string
  port: DeclaredPort
  value: string | null
  kind: string | null
  /** Latest source run id of the bound node — needed for inline-md preview. */
  sourceRunId: string | null
}

function OutputDetail({ taskId, port, value, kind, sourceRunId }: DetailProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)

  const showDownload = isFileOutputKind(kind) && isSingleLinePath(value)

  // RFC-105: a "预览" button for markdown-renderable ports — file ports whose
  // value is a `.md` path or inline `markdown` ports (port mode, body
  // re-resolved from the source run+port on the preview route).
  // RFC-193: file ports carry runId+port too → ARTIFACT source (emit-time
  // archive first, worktree fallback on 404) — a bare file source breaks for
  // wrapper-internal nodes and GC'd worktrees.
  const previewSource: PreviewSource | null =
    !isMarkdownPreviewable(kind, value) || value === null
      ? null
      : isFileOutputKind(kind)
        ? sourceRunId !== null
          ? { kind: 'artifact', path: value.trim(), runId: sourceRunId, port: port.portName }
          : { kind: 'file', path: value.trim() }
        : sourceRunId !== null
          ? { kind: 'port', runId: sourceRunId, port: port.portName }
          : null

  function handleCopy() {
    if (value === null) return
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function handleDownload() {
    if (value === null || downloading) return
    setDownloading(true)
    setDownloadFailed(false)
    // RFC-193: prefer the emit-time archive (404 → worktree fallback inside
    // the helper); no sourceRunId (defensive) → old worktree path directly.
    const dl =
      sourceRunId !== null
        ? downloadPortArtifact(taskId, sourceRunId, port.portName, value.trim())
        : downloadWorktreeFile(taskId, value.trim())
    void dl.catch(() => setDownloadFailed(true)).finally(() => setDownloading(false))
  }

  return (
    <article className="task-outputs-panel__detail-body">
      <header className="task-outputs-panel__detail-header">
        <div>
          <div className="task-outputs-panel__detail-name">{port.name}</div>
          <div className="task-outputs-panel__detail-bind">
            ←{' '}
            <code>
              {port.nodeId}.{port.portName}
            </code>
          </div>
        </div>
        <div className="task-outputs-panel__actions">
          {previewSource !== null && (
            <Link
              {...buildPreviewTarget(taskId, previewSource, port.name)}
              className="btn btn--sm"
              data-testid="task-output-preview"
            >
              {t('taskPreview.button')}
            </Link>
          )}
          {showDownload && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleDownload}
              disabled={downloading}
              data-testid="task-output-download"
            >
              <span aria-hidden="true">↓</span>{' '}
              {downloading ? t('taskOutputs.downloading') : t('taskOutputs.download')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={handleCopy}
            disabled={value === null}
            data-testid="task-output-copy"
          >
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
      </header>
      {downloadFailed && (
        <div
          className="task-outputs-panel__download-error"
          role="alert"
          data-testid="task-output-download-error"
        >
          {t('taskOutputs.downloadFailed')}
        </div>
      )}
      <pre className="task-outputs-panel__pre">
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
