import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`intent-apply-artifact-${key}-invalid`)
  }
  return field
}

function positiveIntegerField(value: Readonly<Record<string, unknown>>, key: string): number {
  const field = value[key]
  if (!Number.isInteger(field) || (field as number) <= 0) {
    throw new Error(`intent-apply-artifact-${key}-invalid`)
  }
  return field as number
}

export function decodeCurrentIntentArtifact(value: unknown): IntentApplyArtifact | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Readonly<Record<string, unknown>>
  switch (record.kind) {
    case 'plugin-install':
      return Object.freeze({
        kind: 'plugin-install',
        pluginId: stringField(record, 'pluginId'),
        generationId: stringField(record, 'generationId'),
        generationDir: stringField(record, 'generationDir'),
      })
    case 'skill-stage':
      if (!('operationId' in record) || !('stagingDirectory' in record)) return null
      return Object.freeze({
        kind: 'skill-stage',
        skillId: stringField(record, 'skillId'),
        operationId: stringField(record, 'operationId'),
        stagingDirectory: stringField(record, 'stagingDirectory'),
      })
    case 'skill-version-stage':
      if (!('operationId' in record) || !('stagingDirectory' in record)) return null
      return Object.freeze({
        kind: 'skill-version-stage',
        skillId: stringField(record, 'skillId'),
        operationId: stringField(record, 'operationId'),
        version: positiveIntegerField(record, 'version'),
        stagingDirectory: stringField(record, 'stagingDirectory'),
        versionDirectory: stringField(record, 'versionDirectory'),
      })
    default:
      return null
  }
}
