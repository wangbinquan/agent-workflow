// Shared name + description field pair. This is the SINGLE source of the two
// metadata inputs that every resource create / rename dialog shows, so those
// dialogs render pixel-identical elements (用户 2026-07-13「让重命名和新建弹窗
// 显示元素一致」). Both QuickCreateDialog (create flow) and RenameDialog
// (workflow editor + workgroup detail rename flow) compose it — never re-author
// the markup inline.
//
// The name input's required flag is baked in (both flows require a name); the
// slug rules are unified (≤128) so maxLength defaults to 128. Everything a
// caller legitimately varies — labels, hint, the inline name error, an optional
// HTML pattern, the description cap — is a prop.

import { Field, TextInput } from '@/components/Form'

export interface NameDescriptionFieldsProps {
  /** testid prefix — renders `${prefix}-name` / `${prefix}-description`
   *  (callers pass e.g. `workflow-create` / `workgroup-rename`). */
  testidPrefix: string
  nameLabel: string
  /** Rule hint under the name label (identical copy across resources). */
  nameHint?: string
  name: string
  onNameChange: (value: string) => void
  /** Translated inline error for a malformed (non-empty) name. */
  nameError?: string
  /** Optional HTML validation pattern (strict-slug resources set it; the
   *  grandfather-name workflow rename relies on nameError instead). */
  namePattern?: string
  nameMaxLength?: number
  descriptionLabel: string
  description: string
  onDescriptionChange: (value: string) => void
  /** Optional cap for the description input (e.g. workgroups' schema max). */
  descriptionMaxLength?: number
}

export function NameDescriptionFields({
  testidPrefix,
  nameLabel,
  nameHint,
  name,
  onNameChange,
  nameError,
  namePattern,
  nameMaxLength = 128,
  descriptionLabel,
  description,
  onDescriptionChange,
  descriptionMaxLength,
}: NameDescriptionFieldsProps) {
  return (
    <>
      {/* Required-ness is conveyed by the disabled confirm button; only a
          malformed (non-empty) name earns the inline error. */}
      <Field label={nameLabel} required hint={nameHint} error={nameError}>
        <TextInput
          value={name}
          onChange={onNameChange}
          pattern={namePattern}
          maxLength={nameMaxLength}
          required
          data-testid={`${testidPrefix}-name`}
        />
      </Field>
      <Field label={descriptionLabel}>
        <TextInput
          value={description}
          onChange={onDescriptionChange}
          maxLength={descriptionMaxLength}
          data-testid={`${testidPrefix}-description`}
        />
      </Field>
    </>
  )
}
