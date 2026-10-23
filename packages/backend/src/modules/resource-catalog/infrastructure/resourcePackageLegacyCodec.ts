// RFC-395 II-a A6 — 旧数组的格式判定只在这里解码，II-b 移入转换器。
import { z } from 'zod'
import { ResourcePackageArtifactSchema } from './resourcePackageCurrentCodec'
const LegacySkillStageArtifactSchema = z
  .object({
    kind: z.literal('skill-stage'),
    skillId: z.string().min(1),
    opId: z.string().min(1),
    skillDir: z.string().min(1),
  })
  .strict()

const LegacySkillVersionStageArtifactSchema = z
  .object({
    kind: z.literal('skill-version-stage'),
    staged: z
      .object({
        skillId: z.string().min(1),
        skillName: z.string(),
        opId: z.string().min(1).nullable(),
        publishId: z.string().min(1),
        newVersion: z.number().int().positive(),
        newHash: z.string().min(1),
        filesDir: z.string().min(1),
        versionDir: z.string().min(1),
        stagingDir: z.string().min(1),
        noop: z.unknown(),
      })
      .strict(),
  })
  .strict()

const LegacyPluginInstallArtifactSchema = z
  .object({
    kind: z.literal('plugin-install'),
    pluginId: z.string().min(1),
    generationId: z.string().min(1),
    generationDir: z.string().min(1),
  })
  .strict()

const LegacyArtifactSchema = z.discriminatedUnion('kind', [
  LegacySkillStageArtifactSchema,
  LegacySkillVersionStageArtifactSchema,
  LegacyPluginInstallArtifactSchema,
])

export type LegacyArtifact = z.infer<typeof LegacyArtifactSchema>
export type LegacySkillVersionArtifact = z.infer<typeof LegacySkillVersionStageArtifactSchema>

export function decodeLegacyResourcePackageArtifactArray(
  value: unknown,
): readonly LegacyArtifact[] {
  return z.array(LegacyArtifactSchema).parse(value)
}

/** HEAD 的整行判定：整个数组必须是当前格式，或整个数组都是旧格式。 */
export function decodeLegacyResourcePackageArtifacts(value: unknown) {
  const current = z.array(ResourcePackageArtifactSchema).safeParse(value)
  return current.success ? current.data : decodeLegacyResourcePackageArtifactArray(value)
}
