// RFC-196 — shared single-file dropzone primitive.
//
// The drop surface is intentionally not a fake button: keyboard users operate
// real buttons, while drag-and-drop remains an optional pointer enhancement.

import { useId, useRef, useState, type ReactNode, type Ref } from 'react'

export interface FileDropzoneProps {
  file: File | null
  onFileChange: (file: File | null) => void
  accept?: string
  disabled?: boolean
  title: string
  description?: string
  chooseLabel: string
  replaceLabel?: string
  removeLabel?: string
  error?: string
  icon?: ReactNode
  inputRef?: Ref<HTMLInputElement>
  buttonRef?: Ref<HTMLButtonElement>
  'data-testid'?: string
}

export function FileDropzone(props: FileDropzoneProps) {
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const descriptionId = useId()
  const errorId = useId()
  const testid = props['data-testid']
  const dragActive = dragDepth > 0

  function setInputRef(node: HTMLInputElement | null) {
    localInputRef.current = node
    assignRef(props.inputRef, node)
  }

  function chooseFile() {
    if (props.disabled === true) return
    localInputRef.current?.click()
  }

  function onInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    if (file !== null) props.onFileChange(file)
    // A user must be able to select the same file again after clearing it.
    event.currentTarget.value = ''
  }

  const describedBy = [
    props.description === undefined ? null : descriptionId,
    props.error ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={[
        'file-dropzone',
        dragActive ? 'file-dropzone--active' : '',
        props.file !== null ? 'file-dropzone--selected' : '',
        props.error ? 'file-dropzone--invalid' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testid === undefined ? undefined : `${testid}-dropzone`}
      onDragEnter={(event) => {
        event.preventDefault()
        if (props.disabled !== true) setDragDepth((depth) => depth + 1)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        if (props.disabled !== true) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        if (props.disabled !== true) setDragDepth((depth) => Math.max(0, depth - 1))
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragDepth(0)
        if (props.disabled === true) return
        const file = event.dataTransfer.files[0]
        if (file !== undefined) props.onFileChange(file)
      }}
      aria-disabled={props.disabled || undefined}
    >
      <input
        ref={setInputRef}
        hidden
        type="file"
        accept={props.accept}
        disabled={props.disabled}
        onChange={onInputChange}
        data-testid={testid}
      />

      {props.icon !== undefined && (
        <div className="file-dropzone__icon" aria-hidden="true">
          {props.icon}
        </div>
      )}

      <div className="file-dropzone__copy">
        <strong className="file-dropzone__title">{props.title}</strong>
        {props.description !== undefined && (
          <span id={descriptionId} className="file-dropzone__description">
            {props.description}
          </span>
        )}
      </div>

      {props.file === null ? (
        <button
          ref={props.buttonRef}
          type="button"
          className="btn btn--primary"
          disabled={props.disabled}
          aria-describedby={describedBy || undefined}
          onClick={chooseFile}
          data-testid={testid === undefined ? undefined : `${testid}-button`}
        >
          {props.chooseLabel}
        </button>
      ) : (
        <div className="file-dropzone__selection">
          <div className="file-dropzone__file" title={props.file.name}>
            <span className="file-dropzone__file-name">{props.file.name}</span>
            <span className="file-dropzone__file-size">{formatShortBytes(props.file.size)}</span>
          </div>
          <div className="file-dropzone__actions">
            <button
              ref={props.buttonRef}
              type="button"
              className="btn btn--sm"
              disabled={props.disabled}
              aria-describedby={describedBy || undefined}
              onClick={chooseFile}
              data-testid={testid === undefined ? undefined : `${testid}-button`}
            >
              {props.replaceLabel ?? props.chooseLabel}
            </button>
            {props.removeLabel !== undefined && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={props.disabled}
                onClick={() => props.onFileChange(null)}
                data-testid={testid === undefined ? undefined : `${testid}-remove`}
              >
                {props.removeLabel}
              </button>
            )}
          </div>
        </div>
      )}

      {props.error !== undefined && props.error !== '' && (
        <div id={errorId} className="file-dropzone__error" role="alert">
          {props.error}
        </div>
      )}
    </div>
  )
}

export interface FilesDropzoneProps {
  files: File[]
  onFilesChange: (next: File[]) => void
  accept?: string
  disabled?: boolean
  title: string
  description?: string
  chooseLabel: string
  removeLabel: string
  /** Hard cap on selected files; extra picks are dropped, choose disables at cap. */
  maxCount?: number
  error?: string
  icon?: ReactNode
  'data-testid'?: string
}

/**
 * RFC-218 — multi-file sibling of FileDropzone (NOT a `multiple` flag on it:
 * the controlled props differ in shape, `file: File|null` vs `files: File[]`).
 * Shares the `.file-dropzone` style namespace and byte formatter. Duplicate
 * picks (same name + size) are skipped so re-picking stays tidy.
 */
export function FilesDropzone(props: FilesDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const descriptionId = useId()
  const errorId = useId()
  const testid = props['data-testid']
  const dragActive = dragDepth > 0
  const atCap = props.maxCount !== undefined && props.files.length >= props.maxCount

  function chooseFiles() {
    if (props.disabled === true || atCap) return
    inputRef.current?.click()
  }

  function addFiles(picked: FileList | null) {
    if (picked === null || picked.length === 0) return
    const next = [...props.files]
    for (const f of Array.from(picked)) {
      if (props.maxCount !== undefined && next.length >= props.maxCount) break
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue
      next.push(f)
    }
    if (next.length !== props.files.length) props.onFilesChange(next)
  }

  const describedBy = [
    props.description === undefined ? null : descriptionId,
    props.error ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={[
        'file-dropzone',
        dragActive ? 'file-dropzone--active' : '',
        props.files.length > 0 ? 'file-dropzone--selected' : '',
        props.error ? 'file-dropzone--invalid' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testid === undefined ? undefined : `${testid}-dropzone`}
      onDragEnter={(event) => {
        event.preventDefault()
        if (props.disabled !== true) setDragDepth((depth) => depth + 1)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        if (props.disabled !== true) event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        if (props.disabled !== true) setDragDepth((depth) => Math.max(0, depth - 1))
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragDepth(0)
        if (props.disabled === true) return
        addFiles(event.dataTransfer.files)
      }}
      aria-disabled={props.disabled || undefined}
    >
      <input
        ref={inputRef}
        hidden
        multiple
        type="file"
        accept={props.accept}
        disabled={props.disabled}
        onChange={(event) => {
          addFiles(event.currentTarget.files)
          // A user must be able to re-pick the same file after removing it.
          event.currentTarget.value = ''
        }}
        data-testid={testid}
      />

      {props.icon !== undefined && (
        <div className="file-dropzone__icon" aria-hidden="true">
          {props.icon}
        </div>
      )}

      <div className="file-dropzone__copy">
        <strong className="file-dropzone__title">{props.title}</strong>
        {props.description !== undefined && (
          <span id={descriptionId} className="file-dropzone__description">
            {props.description}
          </span>
        )}
      </div>

      <button
        type="button"
        className={props.files.length === 0 ? 'btn btn--primary' : 'btn btn--sm'}
        disabled={props.disabled || atCap}
        aria-describedby={describedBy || undefined}
        onClick={chooseFiles}
        data-testid={testid === undefined ? undefined : `${testid}-button`}
      >
        {props.chooseLabel}
      </button>

      {props.files.length > 0 && (
        <ul className="file-dropzone__files">
          {props.files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`} className="file-dropzone__files-row">
              <div className="file-dropzone__file" title={f.name}>
                <span className="file-dropzone__file-name">{f.name}</span>
                <span className="file-dropzone__file-size">{formatShortBytes(f.size)}</span>
              </div>
              <button
                type="button"
                className="btn btn--xs btn--ghost"
                disabled={props.disabled}
                onClick={() => props.onFilesChange(props.files.filter((_, idx) => idx !== i))}
                data-testid={testid === undefined ? undefined : `${testid}-remove-${i}`}
              >
                {props.removeLabel}
              </button>
            </li>
          ))}
        </ul>
      )}

      {props.error !== undefined && props.error !== '' && (
        <div id={errorId} className="file-dropzone__error" role="alert">
          {props.error}
        </div>
      )}
    </div>
  )
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (ref === undefined || ref === null) return
  if (typeof ref === 'function') ref(value)
  else ref.current = value
}

export function formatShortBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${trimOneDecimal(kib)} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${trimOneDecimal(mib)} MiB`
  return `${trimOneDecimal(mib / 1024)} GiB`
}

function trimOneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}
