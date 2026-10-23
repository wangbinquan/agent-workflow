import { z } from 'zod'

export type IntentJournalArtifactV1 =
  | {
      kind: 'plugin-install'
      pluginId: string
      generationId: string
      generationDir: string
    }
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | { kind: 'skill-version-stage'; staged: StagedSkillVersionRecord }

export type IntentJournalArtifact =
  | IntentJournalArtifactV1
  | {
      /** Pre-RFC-271 rows recorded only pluginId. They remain readable, but
       * have no precise generation path to compensate. */
      kind: 'legacy-plugin-install-untracked'
      pluginId: string
    }

const NonEmptyString = z.string().min(1)

/**
 * 已 stage 未提交的技能版本，**按落库形状**声明。
 *
 * RFC-355 T7：这里此前 `import type { StagedSkillVersion }`，直接结构依赖
 * resource-catalog 的 infrastructure——journal 是 intent 自己的持久化契约（行比进程活得久），
 * 不该由别的 context 的实现类型来定义它读回来的形状；而且那个 import 只给 TS 用，
 * 真正的校验一直是下面这份 `.strict()` schema，两份从来不是同一个东西
 * （`noop` 在 RC 的类型里是 `SkillVersionRow | null`，在 schema 里是任意 record）。
 * 现在类型直接由 schema 推导，**schema 是唯一事实源**：解析通过的东西就是这个类型。
 * intent 只把它原样交还给 resource-catalog 的补偿端口（端口签名收 `unknown`），
 * 自己不解读任何字段。
 */
export const StagedSkillVersionSchema = z
  .object({
    skillId: NonEmptyString,
    skillName: NonEmptyString,
    opId: NonEmptyString.nullable(),
    publishId: NonEmptyString,
    newVersion: z.number().int().positive(),
    newHash: z.string(),
    filesDir: NonEmptyString,
    versionDir: NonEmptyString,
    stagingDir: NonEmptyString,
    noop: z.union([z.null(), z.record(z.string(), z.unknown())]),
  })
  .strict()

export type StagedSkillVersionRecord = z.infer<typeof StagedSkillVersionSchema>
