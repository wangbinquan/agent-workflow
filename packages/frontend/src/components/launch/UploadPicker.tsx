// RFC-020 → RFC-218: launcher widget for `kind: 'upload'` inputs, rebuilt on
// the shared FilesDropzone primitive (FileDropzone family) so the launch
// surface matches the skill/agent/workflow import upload experience — drag
// highlight, selected-file cards, per-file remove, a11y. Selected File[] stays
// in parallel-state with the inputs map (File objects never serialize through
// the inputs[key] string slot); on Start they POST as multipart to /api/tasks
// (see buildWorkflowStartFormData).

import { useTranslation } from 'react-i18next'
import type { WorkflowInput } from '@agent-workflow/shared'
import { FilesDropzone } from '@/components/FileDropzone'

interface Props {
  def: WorkflowInput
  files: File[]
  onChange: (next: File[]) => void
}

export function UploadPicker({ def, files, onChange }: Props) {
  const { t } = useTranslation()
  const rec = def as Record<string, unknown>
  const targetDir = typeof rec.targetDir === 'string' ? rec.targetDir : ''
  const accept = Array.isArray(rec.accept) ? (rec.accept as string[]).join(',') : undefined
  const minCount = typeof rec.minCount === 'number' ? rec.minCount : undefined
  const maxCount = typeof rec.maxCount === 'number' ? rec.maxCount : undefined
  const maxFileSize = typeof rec.maxFileSize === 'number' ? rec.maxFileSize : undefined

  const countHint =
    t('launch.upload.selectedCount', { count: files.length }) +
    (minCount !== undefined ? t('launch.upload.minHint', { n: minCount }) : '') +
    (maxCount !== undefined ? t('launch.upload.maxHint', { n: maxCount }) : '')

  return (
    <div className="upload-picker">
      <FilesDropzone
        files={files}
        onFilesChange={onChange}
        accept={accept}
        maxCount={maxCount}
        title={t('launch.upload.dropTitle')}
        description={countHint}
        chooseLabel={t('launch.upload.chooseFiles')}
        removeLabel={t('launch.upload.removeFile')}
        data-testid={`upload-picker-${def.key}`}
      />
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
    </div>
  )
}
