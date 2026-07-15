// RFC-198 — transactional workflow YAML import.
//
// The dialog owns the complete select → conflict → result task. The caller
// owns the API helper and cache invalidation, exposed as one awaited callback
// so a success result is never shown before the gallery has been refreshed.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { Dialog } from './Dialog'
import { ErrorBanner } from './ErrorBanner'
import { FileDropzone } from './FileDropzone'
import { NoticeBanner } from './NoticeBanner'
import { Segmented } from './Segmented'

export type WorkflowImportConflictChoice = 'new' | 'overwrite'
export type WorkflowImportMode = 'fail' | WorkflowImportConflictChoice

export type WorkflowImportState =
  | { kind: 'select'; file: File | null; error: string | null }
  | {
      kind: 'conflict'
      file: File
      yaml: string
      choice: WorkflowImportConflictChoice
      error: string | null
    }
  | { kind: 'result'; message: string }

export interface WorkflowImportDialogProps {
  open: boolean
  onClose: () => void
  onImport: (yaml: string, mode: WorkflowImportMode) => Promise<void>
  triggerRef?: RefObject<HTMLButtonElement | null>
}

function freshState(): WorkflowImportState {
  return { kind: 'select', file: null, error: null }
}

export function WorkflowImportDialog(props: WorkflowImportDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<WorkflowImportState>(freshState)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const openRef = useRef(props.open)
  const requestGenerationRef = useRef(0)
  const chooseButtonRef = useRef<HTMLButtonElement | null>(null)
  const conflictHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    openRef.current = props.open
    if (!props.open) {
      requestGenerationRef.current += 1
      pendingRef.current = false
      setPending(false)
      setState(freshState())
    }
  }, [props.open])

  useEffect(() => {
    if (!props.open || pending) return
    const timer = window.setTimeout(() => {
      if (state.kind === 'select') chooseButtonRef.current?.focus()
      else if (state.kind === 'conflict') conflictHeadingRef.current?.focus()
      else resultHeadingRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [pending, props.open, state.kind])

  async function submit(): Promise<void> {
    if (pendingRef.current || state.kind === 'result') return
    if (state.kind === 'select' && state.file === null) return

    pendingRef.current = true
    setPending(true)
    const generation = ++requestGenerationRef.current
    let snapshot: { file: File; yaml: string; mode: WorkflowImportMode } | null = null
    try {
      let yaml: string
      let file: File
      let mode: WorkflowImportMode
      if (state.kind === 'select') {
        const selectedFile = state.file
        if (selectedFile === null) return
        file = selectedFile
        mode = 'fail'
        try {
          yaml = await file.text()
        } catch (error) {
          if (!isCurrentRequest(generation)) return
          setState({ kind: 'select', file, error: describeApiError(error) })
          return
        }
      } else {
        file = state.file
        yaml = state.yaml
        mode = state.choice
      }

      if (!isCurrentRequest(generation)) return
      snapshot = { file, yaml, mode }
      await props.onImport(yaml, mode)
      if (!isCurrentRequest(generation)) return
      setState({
        kind: 'result',
        message:
          mode === 'overwrite' ? t('workflows.workflowOverwritten') : t('workflows.importedAsNew'),
      })
    } catch (error) {
      if (!isCurrentRequest(generation)) return
      if (
        state.kind === 'select' &&
        snapshot !== null &&
        error instanceof ApiError &&
        error.code === 'workflow-import-conflict'
      ) {
        setState({
          kind: 'conflict',
          file: snapshot.file,
          yaml: snapshot.yaml,
          choice: 'new',
          error: null,
        })
      } else if (state.kind === 'select') {
        setState({ ...state, error: describeApiError(error) })
      } else {
        setState({ ...state, error: describeApiError(error) })
      }
    } finally {
      if (isCurrentRequest(generation)) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  function isCurrentRequest(generation: number): boolean {
    return openRef.current && requestGenerationRef.current === generation
  }

  function close(): void {
    if (!pendingRef.current) props.onClose()
  }

  const submitLabel = pending
    ? t('workflows.importDialog.importing')
    : state.kind !== 'result' && state.error !== null
      ? t('workflows.importDialog.retry')
      : t('workflows.importDialog.import')

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={t('workflows.importDialog.title')}
      size="md"
      triggerRef={props.triggerRef}
      initialFocusRef={chooseButtonRef}
      dismissDisabled={pending}
      data-testid="workflow-import-dialog"
      footer={
        state.kind === 'result' ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setState(freshState())}
              data-testid="workflow-import-another"
            >
              {t('workflows.importDialog.another')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={close}
              data-testid="workflow-import-close"
            >
              {t('common.close')}
            </button>
          </>
        ) : (
          <>
            {state.kind === 'conflict' && (
              <button
                type="button"
                className="btn"
                disabled={pending}
                onClick={() => setState({ kind: 'select', file: state.file, error: null })}
                data-testid="workflow-import-back"
              >
                {t('workflows.importDialog.chooseAnother')}
              </button>
            )}
            <button type="button" className="btn" disabled={pending} onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pending || (state.kind === 'select' && state.file === null)}
              aria-busy={pending}
              onClick={() => void submit()}
              data-testid="workflow-import-submit"
            >
              {submitLabel}
            </button>
          </>
        )
      }
    >
      {state.kind === 'select' && (
        <FileDropzone
          file={state.file}
          onFileChange={(file) => {
            requestGenerationRef.current += 1
            setState({ kind: 'select', file, error: null })
          }}
          accept=".yaml,.yml,application/yaml,text/yaml"
          disabled={pending}
          title={t('workflows.importDialog.dropTitle')}
          description={t('workflows.importDialog.dropDescription')}
          chooseLabel={t('workflows.importDialog.chooseFile')}
          replaceLabel={t('workflows.importDialog.replaceFile')}
          removeLabel={t('workflows.importDialog.removeFile')}
          error={state.error ?? undefined}
          buttonRef={chooseButtonRef}
          data-testid="workflow-import-file"
        />
      )}

      {state.kind === 'conflict' && (
        <div className="stack--md" data-testid="workflow-import-conflict">
          <h3 ref={conflictHeadingRef} tabIndex={-1}>
            {t('workflows.importDialog.conflictTitle')}
          </h3>
          <NoticeBanner tone="warning" size="compact">
            {t('workflows.importDialog.conflictDescription', { file: state.file.name })}
          </NoticeBanner>
          <Segmented<WorkflowImportConflictChoice>
            value={state.choice}
            onChange={(choice) => setState({ ...state, choice, error: null })}
            options={[
              { value: 'new', label: t('workflows.importDialog.choiceNew') },
              { value: 'overwrite', label: t('workflows.importDialog.choiceOverwrite') },
            ]}
            ariaLabel={t('workflows.importDialog.conflictChoiceLabel')}
            disabled={pending}
            testidPrefix="workflow-import-choice"
          />
          {state.error !== null && <ErrorBanner error={state.error} />}
        </div>
      )}

      {state.kind === 'result' && (
        <div className="stack--md" data-testid="workflow-import-result">
          <h3 ref={resultHeadingRef} tabIndex={-1}>
            {t('workflows.importDialog.resultTitle')}
          </h3>
          <NoticeBanner tone="success" size="compact">
            {state.message}
          </NoticeBanner>
        </div>
      )}
    </Dialog>
  )
}
