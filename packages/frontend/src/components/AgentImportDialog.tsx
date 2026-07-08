// RFC-018 — Import dialog for /agents/new.
// Two input paths: upload .md / .markdown file, or paste raw text.
// Hands the parsed result back via onApply for merge into AgentForm draft.
//
// RFC-035 PR3: chrome (overlay + panel + header + close + footer + focus
// trap + ESC + body overflow) is now owned by the shared <Dialog>; this
// component owns just the body (tabs / upload / paste / preview).

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import { parseAgentMarkdown } from '@agent-workflow/shared'
import { emptyAgent } from './AgentForm'
import { fieldsOverwrittenByImport } from '@/lib/agent-import-merge'
import { structureImportWarnings } from '@/lib/agent-import-warnings'
import { Dialog } from './Dialog'
import { TabBar } from './TabBar'

export interface AgentImportDialogProps {
  open: boolean
  onClose: () => void
  onApply: (result: AgentMarkdownParseResult) => void
  currentValue: CreateAgent
}

type Tab = 'upload' | 'paste'

const ROUTE_KEYS = {
  name: 'agentForm.importDialog.routedTo.name',
  description: 'agentForm.importDialog.routedTo.description',
  permission: 'agentForm.importDialog.routedTo.permission',
  bodyMd: 'agentForm.importDialog.routedTo.bodyMd',
  frontmatterExtra: 'agentForm.importDialog.routedTo.frontmatterExtra',
} as const

export function AgentImportDialog({
  open,
  onClose,
  onApply,
  currentValue,
}: AgentImportDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('upload')
  const [rawText, setRawText] = useState('')
  const [filenameStem, setFilenameStem] = useState<string | undefined>(undefined)
  const [parseResult, setParseResult] = useState<AgentMarkdownParseResult | null>(null)

  useEffect(() => {
    if (!open) {
      // Reset state every time dialog re-opens for a fresh import session.
      setTab('upload')
      setRawText('')
      setFilenameStem(undefined)
      setParseResult(null)
    }
  }, [open])

  const willOverwrite = useMemo(() => {
    if (parseResult === null) return [] as string[]
    return fieldsOverwrittenByImport(currentValue, parseResult, emptyAgent())
  }, [parseResult, currentValue])

  // RFC-151 PR-1 — normalize the parser's string[] once; every consumer below
  // reads {code, message, blocking} instead of sniffing string prefixes.
  const warnings = useMemo(
    () => structureImportWarnings(parseResult?.warnings ?? []),
    [parseResult],
  )
  const blockingWarning = warnings.find((w) => w.blocking)
  const hasYamlError = blockingWarning !== undefined

  if (!open) return null

  async function onFileSelected(file: File | null) {
    if (!file) return
    const text = await file.text()
    setRawText(text)
    const m = /^(.+?)(?:\.(?:md|markdown))?$/i.exec(file.name)
    setFilenameStem(m?.[1] ?? file.name)
    setParseResult(null)
  }

  function doParse() {
    if (rawText === '') return
    const r = parseAgentMarkdown(rawText, {
      filenameStem: tab === 'upload' ? filenameStem : undefined,
    })
    setParseResult(r)
  }

  function doApply() {
    if (parseResult === null || hasYamlError) return
    onApply(parseResult)
    onClose()
  }

  function describePreview(): Array<{
    field: string
    value: string
    routeKey: string
  }> {
    if (parseResult === null) return []
    const out: Array<{ field: string; value: string; routeKey: string }> = []
    const p = parseResult.partial
    const add = (field: keyof typeof p, routeKey: string, valueStr?: string) => {
      const v = p[field]
      if (v === undefined) return
      out.push({
        field,
        value: valueStr ?? renderPreviewValue(v),
        routeKey,
      })
    }
    add('name', ROUTE_KEYS.name)
    add('description', ROUTE_KEYS.description)
    add('permission', ROUTE_KEYS.permission)
    if (p.frontmatterExtra !== undefined) {
      for (const key of Object.keys(p.frontmatterExtra)) {
        out.push({
          field: key,
          value: renderPreviewValue(p.frontmatterExtra[key]),
          routeKey: ROUTE_KEYS.frontmatterExtra,
        })
      }
    }
    if (p.bodyMd !== undefined) {
      const sz = new Blob([p.bodyMd]).size
      out.push({
        field: 'body',
        value: t('agentForm.importDialog.bodySizeHint', { bytes: sz }),
        routeKey: ROUTE_KEYS.bodyMd,
      })
    }
    return out
  }

  const previewRows = describePreview()

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('agentForm.importDialog.title')}
      size="lg"
      panelClassName="agent-import__panel"
      data-testid="agent-import-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('agentForm.importDialog.cancelButton')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={parseResult === null || hasYamlError}
            data-testid="agent-import-apply"
            onClick={doApply}
          >
            {t('agentForm.importDialog.applyButton')}
          </button>
        </>
      }
    >
      <div>
        <TabBar<Tab>
          variant="inline"
          tabs={[
            { key: 'upload', label: t('agentForm.importDialog.tabUpload') },
            { key: 'paste', label: t('agentForm.importDialog.tabPaste') },
          ]}
          active={tab}
          onSelect={setTab}
        />

        {tab === 'upload' ? (
          <div className="agent-import__upload">
            <input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              data-testid="agent-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                void onFileSelected(f)
              }}
            />
            {filenameStem !== undefined && (
              <p className="agent-import__filename">
                {t('agentForm.importDialog.selectedFile', { name: filenameStem })}
              </p>
            )}
          </div>
        ) : (
          <textarea
            className="form-input agent-import__textarea"
            rows={14}
            value={rawText}
            data-testid="agent-import-textarea"
            placeholder={t('agentForm.importDialog.pastePlaceholder')}
            onChange={(e) => {
              setRawText(e.target.value)
              setFilenameStem(undefined)
              setParseResult(null)
            }}
          />
        )}

        <div className="agent-import__actions-row">
          <button
            type="button"
            className="btn"
            disabled={rawText === ''}
            data-testid="agent-import-parse"
            onClick={doParse}
          >
            {t('agentForm.importDialog.parseButton')}
          </button>
          <span className="agent-import__hint">{t('agentForm.importDialog.footerHint')}</span>
        </div>

        {parseResult !== null && (
          <section className="agent-import__preview" aria-live="polite">
            {blockingWarning !== undefined && (
              <div className="agent-import__warning" data-testid="agent-import-warning">
                {blockingWarning.message}
              </div>
            )}
            {!hasYamlError && willOverwrite.length > 0 && (
              <div className="agent-import__overwrite" data-testid="agent-import-overwrite">
                {t('agentForm.importDialog.willOverwrite', {
                  count: willOverwrite.length,
                  fields: willOverwrite.join(', '),
                })}
              </div>
            )}
            {!hasYamlError && warnings.length > 0 && (
              <ul className="agent-import__warnings">
                {warnings
                  .filter((w) => !w.blocking)
                  .map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
              </ul>
            )}
            {previewRows.length === 0 ? (
              <p className="agent-import__empty">{t('agentForm.importDialog.previewEmpty')}</p>
            ) : (
              <table className="data-table data-table--compact agent-import__table">
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={`${row.field}-${i}`}>
                      <td className="agent-import__field">{row.field}</td>
                      <td className="agent-import__value">{row.value}</td>
                      <td className="agent-import__route">{t(row.routeKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </Dialog>
  )
}

function renderPreviewValue(v: unknown): string {
  if (typeof v === 'string') {
    return v.length > 60 ? `${v.slice(0, 57)}…` : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  try {
    const json = JSON.stringify(v)
    return json.length > 60 ? `${json.slice(0, 57)}…` : json
  } catch {
    return String(v)
  }
}
