import { WorkgroupSystemTemplateSchema, type WorkgroupMessage } from '@agent-workflow/shared'
import type { TFunction } from 'i18next'

/** Viewer-localized projection. Agent context and storage continue to use bodyMd. */
export function resolveWorkgroupMessageBody(
  message: Pick<WorkgroupMessage, 'bodyMd' | 'templateKey' | 'templateParams'>,
  t: TFunction,
): string {
  const key = message.templateKey ?? null
  const params = message.templateParams ?? null
  if (key === null || params === null) return message.bodyMd
  const parsed = WorkgroupSystemTemplateSchema.safeParse({ key, params })
  if (!parsed.success) return message.bodyMd
  const translationKey = `workgroups.systemMessages.${parsed.data.key}`
  try {
    const rendered = t(translationKey, { ...parsed.data.params, defaultValue: message.bodyMd })
    return typeof rendered === 'string' && rendered !== translationKey ? rendered : message.bodyMd
  } catch {
    return message.bodyMd
  }
}
