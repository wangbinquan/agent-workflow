// RFC-020: launcher widget for `kind: 'upload'` inputs. The user picks
// local files from their machine; on Start we POST them as multipart to
// /api/tasks (see buildWorkflowStartFormData). We keep selected File[] in
// parallel-state with the inputs map so File objects don't need to be
// serialized through the inputs[key] string slot.

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkflowInput } from '@agent-workflow/shared'

interface Props {
  def: WorkflowInput
  files: File[]
  onChange: (next: File[]) => void
}

export function UploadPicker({ def, files, onChange }: Props) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const rec = def as Record<string, unknown>
  const targetDir = typeof rec.targetDir === 'string' ? rec.targetDir : ''
  const accept = Array.isArray(rec.accept) ? (rec.accept as string[]).join(',') : undefined
  const minCount = typeof rec.minCount === 'number' ? rec.minCount : undefined
  const maxCount = typeof rec.maxCount === 'number' ? rec.maxCount : undefined
  const maxFileSize = typeof rec.maxFileSize === 'number' ? rec.maxFileSize : undefined

  function add(picked: FileList | null) {
    if (picked === null) return
    const next = [...files]
    for (const f of Array.from(picked)) {
      if (maxCount !== undefined && next.length >= maxCount) break
      // Skip exact dup (name + size) to keep the list tidy when re-picking.
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue
      next.push(f)
    }
    onChange(next)
  }

  function remove(idx: number) {
    onChange(files.filter((_, i) => i !== idx))
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    add(e.dataTransfer.files)
  }

  return (
    <div className="upload-picker">
      <div className="upload-picker__drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          style={{ display: 'none' }}
          onChange={(e) => {
            add(e.target.files)
            // Allow re-picking the same file: clear the input so the next
            // selection fires onChange even if names match.
            if (e.target.value !== '') e.target.value = ''
          }}
        />
        <button type="button" className="btn btn--sm" onClick={() => inputRef.current?.click()}>
          {t('launch.upload.chooseFiles')}
        </button>
        <span className="muted upload-picker__hint">
          {t('launch.upload.selectedCount', { count: files.length })}
          {minCount !== undefined ? t('launch.upload.minHint', { n: minCount }) : ''}
          {maxCount !== undefined ? t('launch.upload.maxHint', { n: maxCount }) : ''}
        </span>
      </div>
      <div className="muted upload-picker__targetdir">
        {t('launch.upload.targetDirHint', { dir: targetDir || '/' })}
      </div>
      {accept !== undefined && accept !== '' && (
        <div className="muted upload-picker__accept">
          {t('launch.upload.acceptHint', { accept })}
        </div>
      )}
      {maxFileSize !== undefined && (
        <div className="muted upload-picker__maxsize">
          {t('launch.upload.maxSizeHint', { bytes: maxFileSize })}
        </div>
      )}
      {files.length > 0 && (
        <ul className="upload-picker__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`} className="upload-picker__row">
              <code>{f.name}</code>
              <span className="muted">{humanSize(f.size)}</span>
              <button type="button" className="btn btn--xs btn--ghost" onClick={() => remove(i)}>
                {t('launch.upload.removeFile')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
