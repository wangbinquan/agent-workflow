import { BUNDLE_RESOURCE_TYPES } from '@agent-workflow/shared'
import { z } from 'zod'
export const ResourcePackageArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plugin-install'),
      operationId: z.string().min(1),
      pluginId: z.string().min(1),
      generationId: z.string().min(1),
      generationDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-stage'),
      operationId: z.string().min(1),
      skillId: z.string().min(1),
      stagingDirectory: z.string().min(1),
      targetDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-version-stage'),
      operationId: z.string().min(1),
      skillId: z.string().min(1),
      publishId: z.string().min(1),
      version: z.number().int().positive(),
      stagingDirectory: z.string().min(1),
      versionDirectory: z.string().min(1),
    })
    .strict(),
])

const AppliedReceiptSchema = z
  .object({
    resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
    operationId: z.string().min(1),
    resourceId: z.string().min(1),
    action: z.enum(['create', 'update']),
    name: z.string(),
  })
  .strict()

export const ResourcePackageReceiptSchema = z
  .object({
    journalId: z.string().min(1),
    applied: z.array(AppliedReceiptSchema),
    root: z
      .object({
        resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
        resourceId: z.string().min(1),
        name: z.string(),
        action: z.enum(['create', 'update', 'reuse']),
      })
      .strict()
      .optional(),
    skippedSecrets: z
      .array(
        z
          .object({
            resourceType: z.enum(BUNDLE_RESOURCE_TYPES),
            resourceName: z.string(),
            field: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export type ResourcePackageCurrentArtifact = z.infer<typeof ResourcePackageArtifactSchema>
export type ResourcePackageCurrentReceipt = z.infer<typeof ResourcePackageReceiptSchema>
