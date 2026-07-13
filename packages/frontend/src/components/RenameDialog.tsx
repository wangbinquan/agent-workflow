// Shared rename dialog — edits a resource's name + description (2026-07-13,
// 用户「把名称和描述修改收到和工作组一样的重命名按钮内」+「让重命名和新建弹窗
// 显示元素一致」). Used by the workflow editor and the workgroup detail page;
// it renders the SAME NameDescriptionFields primitive the create dialog uses,
// so the two dialogs show identical elements. Semantics differ from create
// (this saves an existing resource, not POST-a-new-one), so it stays a distinct
// component — only the field markup is shared.
//
// Presentational only: the parent owns the draft state, name validation and the
// save mutation (workflow PUT vs. workgroup POST /rename), and decides what
// `canSave` means. testids: `${prefix}-rename-{dialog,name,description,confirm}`.

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { NameDescriptionFields } from '@/components/NameDescriptionFields'

export interface RenameDialogProps {
  open: boolean
  onClose: () => void
  title: string
  /** data-testid prefix: `<prefix>-rename-{dialog,name,description,confirm}`. */
  testidPrefix: string
  nameLabel: string
  nameHint?: string
  name: string
  onNameChange: (value: string) => void
  nameError?: string
  namePattern?: string
  descriptionLabel: string
  description: string
  onDescriptionChange: (value: string) => void
  descriptionMaxLength?: number
  /** Parent's verdict — gates the confirm button (valid name + something
   *  actually changed). */
  canSave: boolean
  pending: boolean
  /** Translated error from the save mutation, shown in the footer. */
  submitError?: string
  onSave: () => void
  triggerRef?: RefObject<HTMLButtonElement | null>
}

export function RenameDialog({
  open,
  onClose,
  title,
  testidPrefix,
  nameLabel,
  nameHint,
  name,
  onNameChange,
  nameError,
  namePattern,
  descriptionLabel,
  description,
  onDescriptionChange,
  descriptionMaxLength,
  canSave,
  pending,
  submitError,
  onSave,
  triggerRef,
}: RenameDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      triggerRef={triggerRef}
      data-testid={`${testidPrefix}-rename-dialog`}
      footer={
        <>
          {submitError !== undefined && <span className="form-actions__error">{submitError}</span>}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending || !canSave}
            onClick={onSave}
            data-testid={`${testidPrefix}-rename-confirm`}
          >
            {pending ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <NameDescriptionFields
        testidPrefix={`${testidPrefix}-rename`}
        nameLabel={nameLabel}
        nameHint={nameHint}
        name={name}
        onNameChange={onNameChange}
        nameError={nameError}
        namePattern={namePattern}
        descriptionLabel={descriptionLabel}
        description={description}
        onDescriptionChange={onDescriptionChange}
        descriptionMaxLength={descriptionMaxLength}
      />
    </Dialog>
  )
}
