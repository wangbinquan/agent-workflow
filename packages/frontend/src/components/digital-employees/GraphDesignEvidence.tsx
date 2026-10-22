import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { saveBlobAs } from '@/lib/download'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import type { GraphDesignDocument } from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { Field, TextArea } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { EmptyState } from '@/components/EmptyState'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import type { GraphEvidenceData } from './graphDesignModel'

function RetainedFile({ file, zh }: { file: { path: string; content: string }; zh: boolean }) {
  let report: { kind?: string; sourcePath?: string; text?: string | null; base64?: string } | null =
    null
  try {
    report = JSON.parse(file.content)
  } catch {
    /* Raw logs are plain text. */
  }
  if (
    report?.kind !== 'graph-retained-file' ||
    !report.sourcePath ||
    typeof report.base64 !== 'string'
  )
    return (
      <details open>
        <summary>{file.path}</summary>
        <pre>{file.content}</pre>
      </details>
    )
  const sourcePath = report.sourcePath,
    encoded = report.base64
  return (
    <details open>
      <summary>{sourcePath}</summary>
      {report.text !== null ? (
        <pre>{report.text}</pre>
      ) : (
        <p>
          {zh ? '二进制报告，下载可读取原始字节。' : 'Binary report. Download its original bytes.'}
        </p>
      )}
      <button
        type="button"
        className="btn btn--sm"
        onClick={() =>
          saveBlobAs(
            new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))]),
            sourcePath.split('/').at(-1) ?? 'report',
          )
        }
      >
        {zh ? '下载报告' : 'Download report'}
      </button>
    </details>
  )
}

export function GraphDesignEvidence({
  data,
  document,
  canEdit,
  busy,
  zh,
  onVerify,
  onAccept,
  onLocate,
}: {
  data: GraphEvidenceData
  document: GraphDesignDocument
  canEdit: boolean
  busy: boolean
  zh: boolean
  onVerify(): void
  onAccept(input: {
    obligationId: string
    basisDigest: string
    candidateTreeOid: string
    result: 'passed' | 'failed'
    comment: string
  }): Promise<boolean>
  onLocate(id: string): void
}) {
  const [accepting, setAccepting] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [result, setResult] = useState<'passed' | 'failed'>('passed')
  const [viewing, setViewing] = useState<string | null>(null)
  const raw = useQuery({
    queryKey: ['graph-evidence-artifacts', document.id, viewing],
    enabled: viewing !== null,
    queryFn: () =>
      api.get<{ files: { path: string; content: string }[] }>(
        `/api/development-designs/${encodeURIComponent(document.id)}/evidence/${encodeURIComponent(viewing!)}/artifacts`,
      ),
  })
  const candidate = [...data.evidence]
    .filter((item) => item.evidence.candidateTreeOid && item.freshness === 'current')
    .sort((a, b) => b.evidence.recordedAt - a.evidence.recordedAt)[0]?.evidence
  return (
    <Card
      title={zh ? '验证与交付证据' : 'Verification and delivery evidence'}
      actions={
        canEdit && (
          <button type="button" className="btn btn--sm" disabled={busy} onClick={onVerify}>
            {zh ? '重新验证候选' : 'Verify candidate again'}
          </button>
        )
      }
    >
      <div className="graph-design__stack">
        <NoticeBanner tone="info">
          {zh
            ? '图的结构检查、设计批准、代码执行和人工验收分别记录。测试引用已核对只代表能定位到候选内容。'
            : 'Structure, design approval, code execution and human acceptance are separate. A checked test reference only confirms its presence in the candidate.'}
        </NoticeBanner>
        {(['structure', 'design-review', 'execution', 'acceptance'] as const).map((kind) => (
          <section key={kind}>
            <h4>
              {
                {
                  structure: zh ? '结构检查' : 'Structure',
                  'design-review': zh ? '设计审核' : 'Design review',
                  execution: zh ? '代码执行' : 'Code execution',
                  acceptance: zh ? '人工验收' : 'Human acceptance',
                }[kind]
              }
            </h4>
            {!data.evidence.some((item) => item.evidence.kind === kind) && (
              <p className="muted">{zh ? '尚无证据' : 'No evidence yet'}</p>
            )}
            {data.evidence
              .filter((item) => item.evidence.kind === kind)
              .map((item) => (
                <div key={item.evidence.id} className="graph-design__stack">
                  <strong>
                    {item.evidence.result} · {item.freshness}
                  </strong>
                  <p>{item.evidence.summary}</p>
                  {item.evidence.artifactRef && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setViewing(item.evidence.id)}
                    >
                      {zh ? '查看原始证据与日志' : 'Inspect original evidence and logs'}
                    </button>
                  )}
                  {item.reasons.length > 0 && (
                    <NoticeBanner tone="warning">{item.reasons.join(' · ')}</NoticeBanner>
                  )}
                  <p className="muted">{item.evidence.limitations.join(' ')}</p>
                  <details>
                    <summary>{zh ? '版本与执行来源' : 'Versions and execution provenance'}</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          basis: item.evidence.basisDigest,
                          tree: item.evidence.candidateTreeOid,
                          commit: item.evidence.commitSha,
                          profile: item.evidence.profileRef,
                          environment: item.evidence.environmentDigest,
                          execution: item.evidence.executionRef,
                          artifact: item.evidence.artifactRef,
                          ci: item.evidence.ci,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              ))}
          </section>
        ))}
        {data.obligations.map((item) => {
          const obligation = document.obligations.find((o) => o.id === item.obligationId)
          return (
            <section key={item.obligationId}>
              <strong>
                {obligation?.statement ?? item.obligationId} · {item.state}
              </strong>
              <div className="graph-design__actions">
                {obligation?.elementIds.map((id) => (
                  <button
                    type="button"
                    className="btn btn--xs"
                    key={id}
                    onClick={() => onLocate(id)}
                  >
                    {zh ? '定位' : 'Locate'}{' '}
                    {document.elements.find((e) => e.id === id)?.label ?? id}
                  </button>
                ))}
                {canEdit && obligation?.verification.kind === 'manual' && candidate && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => {
                      setAccepting(item.obligationId)
                      setComment('')
                    }}
                  >
                    {zh ? '记录人工验收' : 'Record acceptance'}
                  </button>
                )}
              </div>
            </section>
          )
        })}
        {!data.traces.length && (
          <EmptyState
            size="compact"
            title={zh ? '尚无代码与测试追溯' : 'No code and test traces yet'}
          />
        )}
        {data.traces.map((trace) => (
          <section key={trace.id}>
            <button type="button" className="btn btn--xs" onClick={() => onLocate(trace.elementId)}>
              {document.elements.find((e) => e.id === trace.elementId)?.label ?? trace.elementId}
            </button>
            <p>
              <code>{trace.path}</code> · {trace.symbol ?? trace.testRef ?? '—'} · {trace.status}
            </p>
            <p className="muted">{trace.reason}</p>
          </section>
        ))}
      </div>
      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        size="lg"
        title={zh ? '原始验证证据' : 'Original verification evidence'}
        footer={
          <button
            type="button"
            className="btn"
            disabled={!raw.data}
            onClick={() => {
              if (raw.data)
                saveBlobAs(
                  new Blob([JSON.stringify(raw.data, null, 2)], { type: 'application/json' }),
                  'graph-evidence.json',
                )
            }}
          >
            {zh ? '导出原始证据' : 'Export original evidence'}
          </button>
        }
      >
        {raw.isLoading && <LoadingState />}
        {raw.error && <ErrorBanner error={raw.error} />}
        {raw.data?.files.map((file) => (
          <RetainedFile key={file.path} file={file} zh={zh} />
        ))}
      </Dialog>
      <Dialog
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title={zh ? '记录候选的人工验收' : 'Record acceptance of this candidate'}
        dismissDisabled={busy}
        footer={
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !comment.trim() || !candidate}
            onClick={() => {
              if (candidate?.candidateTreeOid && accepting)
                void onAccept({
                  obligationId: accepting,
                  basisDigest: candidate.basisDigest,
                  candidateTreeOid: candidate.candidateTreeOid,
                  result,
                  comment,
                }).then((saved) => {
                  if (saved) setAccepting(null)
                })
            }}
          >
            {zh ? '保存验收结论' : 'Save acceptance'}
          </button>
        }
      >
        <div className="graph-design__stack">
          <p>
            {zh ? '本判断只适用于以下候选内容：' : 'This judgment applies only to this candidate:'}{' '}
            <code>{candidate?.candidateTreeOid}</code>
          </p>
          <Field label={zh ? '结论' : 'Result'}>
            <Select
              value={result}
              onChange={setResult}
              options={[
                { value: 'passed', label: zh ? '通过' : 'Passed' },
                { value: 'failed', label: zh ? '未通过' : 'Failed' },
              ]}
            />
          </Field>
          <Field label={zh ? '操作与观察结果' : 'Steps and observations'} required>
            <TextArea value={comment} onChange={setComment} />
          </Field>
        </div>
      </Dialog>
    </Card>
  )
}
