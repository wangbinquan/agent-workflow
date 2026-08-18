// RFC-310 PR-8 T92 —— pipeline evidence 浏览：gate 摘要 + 文件清单 + 有界
// ranged 预览。铁律两条：①内容是外部程序输出，**不可信**——只读 monospace
// 文本呈现（React 文本节点天然不渲染 HTML），预览区顶部常驻警示；②截断
// 诚实——后端 4MiB 上限 + `x-evidence-next-offset` 续读协议，「继续加载」
// 按 offset 追加，绝不把半份日志冒充完整。

import { useMutation } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'

/** 后端 detail 投影的 pipeline 摘要（routes/developmentMissions.ts GET :id）。 */
export interface PipelineEvidenceSummary {
  bundleId: string
  headSha: string
  completeness: 'complete' | 'partial'
  /** cells 原样字符串（epoch ms）；缺失 = 未记录。 */
  collectedAt: string | null
  gates: {
    gateKey: string
    required: boolean
    status: string
    runRef: string
    attempt: number
    failureCategories: string[]
  }[]
  files: {
    fileId: string
    relativePath: string
    mediaType: string
    bytes: number
    sha256: string
  }[]
}

interface PreviewState {
  sha256: string
  relativePath: string
  text: string
  totalBytes: number
  nextOffset: number | null
}

const PREVIEW_CHUNK_BYTES = 256 * 1024

function gateChipKind(status: string): 'success' | 'warn' | 'danger' | 'info' {
  if (status === 'pass') return 'success'
  if (status === 'fail' || status === 'canceled' || status === 'unavailable') return 'danger'
  if (status === 'queued' || status === 'running') return 'info'
  return 'warn'
}

export function EvidenceBrowser(props: {
  missionId: string
  pipeline: PipelineEvidenceSummary
}): ReactElement {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<PreviewState | null>(null)

  const load = useMutation({
    mutationFn: async (input: { sha256: string; relativePath: string; offset: number }) => {
      const range = await api.getEvidenceRange(
        `/api/code/missions/${encodeURIComponent(props.missionId)}/pipeline-evidence/${input.sha256}`,
        { offset: input.offset, limit: PREVIEW_CHUNK_BYTES },
      )
      return { ...input, range }
    },
    onSuccess: ({ sha256, relativePath, offset, range }) => {
      setPreview((prev) =>
        prev !== null && prev.sha256 === sha256 && offset > 0
          ? { ...prev, text: prev.text + range.text, nextOffset: range.nextOffset }
          : {
              sha256,
              relativePath,
              text: range.text,
              totalBytes: range.totalBytes,
              nextOffset: range.nextOffset,
            },
      )
    },
  })

  return (
    <div className="evidence-browser" data-testid="evidence-browser">
      <dl className="mission-kv">
        <dt>{t('code.missions.evidenceHead')}</dt>
        <dd>
          <code>{props.pipeline.headSha.slice(0, 12)}</code>{' '}
          <StatusChip
            size="sm"
            kind={props.pipeline.completeness === 'complete' ? 'success' : 'warn'}
          >
            {props.pipeline.completeness}
          </StatusChip>
        </dd>
        <dt>{t('code.missions.evidenceCollectedAt')}</dt>
        <dd>
          {props.pipeline.collectedAt === null ||
          !Number.isFinite(Number.parseInt(props.pipeline.collectedAt, 10))
            ? '—'
            : new Date(Number.parseInt(props.pipeline.collectedAt, 10)).toLocaleString()}
        </dd>
      </dl>

      <TableViewport label={t('code.missions.evidenceGatesTitle')}>
        <table data-testid="evidence-gates">
          <thead>
            <tr>
              <th scope="col">{t('code.missions.colGate')}</th>
              <th scope="col">{t('code.missions.colState')}</th>
              <th scope="col">{t('code.missions.colRun')}</th>
            </tr>
          </thead>
          <tbody>
            {props.pipeline.gates.map((gate) => (
              <tr key={gate.gateKey + gate.runRef}>
                <td>
                  {gate.gateKey}
                  {gate.required ? ' *' : ''}
                </td>
                <td>
                  <StatusChip size="sm" kind={gateChipKind(gate.status)}>
                    {gate.status}
                  </StatusChip>
                </td>
                <td>
                  <code>{gate.runRef}</code>
                  {gate.failureCategories.length > 0 ? (
                    <span className="evidence-browser__meta">
                      {' '}
                      {gate.failureCategories.join(', ')}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>

      {load.isError ? <ErrorBanner error={load.error} /> : null}
      {props.pipeline.files.length === 0 ? (
        <p>{t('code.missions.evidenceNoFiles')}</p>
      ) : (
        <TableViewport label={t('code.missions.evidenceFilesTitle')}>
          <table data-testid="evidence-files">
            <thead>
              <tr>
                <th scope="col">{t('code.missions.colFile')}</th>
                <th scope="col">{t('code.missions.colBytes')}</th>
                <th scope="col" aria-label={t('code.missions.colActions')} />
              </tr>
            </thead>
            <tbody>
              {props.pipeline.files.map((file) => (
                <tr key={file.sha256 + file.relativePath}>
                  <td>{file.relativePath}</td>
                  <td>{file.bytes}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--xs"
                      disabled={load.isPending}
                      onClick={() =>
                        load.mutate({
                          sha256: file.sha256,
                          relativePath: file.relativePath,
                          offset: 0,
                        })
                      }
                      data-testid={`evidence-view-${file.fileId}`}
                    >
                      {t('code.missions.viewFile')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}

      {preview !== null ? (
        <div className="evidence-browser__preview" data-testid="evidence-preview">
          <p className="evidence-browser__warning" role="note">
            {t('code.missions.evidenceUntrusted')}
          </p>
          <h4>
            {preview.relativePath}{' '}
            <span className="evidence-browser__meta">
              {t('code.missions.evidenceLoaded', {
                loaded: preview.text.length,
                total: preview.totalBytes,
              })}
            </span>
          </h4>
          <pre className="evidence-browser__content">{preview.text}</pre>
          {preview.nextOffset !== null ? (
            <button
              type="button"
              className="btn btn--sm"
              disabled={load.isPending}
              onClick={() =>
                load.mutate({
                  sha256: preview.sha256,
                  relativePath: preview.relativePath,
                  offset: preview.nextOffset ?? 0,
                })
              }
              data-testid="evidence-load-more"
            >
              {t('code.missions.evidenceLoadMore')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
