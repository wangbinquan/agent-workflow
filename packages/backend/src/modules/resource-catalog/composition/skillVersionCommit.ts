// RFC-353 T6/T7 / RFC-370 §10 V20 —— 「推进技能版本」那一半的装配出口。
//
// 工厂与数据库无关：调用方（knowledge-evolution 的融合仓库）用自己的数据库句柄 `bind`，拿到绑在
// **选定内容绑定**上的 participant——本地部署走文件存储，托管部署走 `skill_content_entries`。
// 不传选择即本地文件存储，根目录取 `bind` 时给的 appHome。

import type { ProviderNeutralDatabase } from '@/db/query'

import { createFileSkillTreeContentStore } from '../infrastructure/local/fileSkillTreeContentStore'
import {
  createSkillTreeVersionParticipant,
  type SkillTreeVersionParticipant,
} from '../infrastructure/skillTreeVersionParticipant'
import type { SkillContentBinding } from './skillContentBinding'

export type { SkillTreeVersionParticipant } from '../infrastructure/skillTreeVersionParticipant'

export interface SkillVersionCommitParticipantFactory {
  bind(input: {
    readonly db: ProviderNeutralDatabase
    readonly appHome: string
  }): SkillTreeVersionParticipant
}

export function composeSkillVersionCommitParticipantFactory(
  selection: { readonly skillContent?: SkillContentBinding } = {},
): SkillVersionCommitParticipantFactory {
  return Object.freeze({
    bind(input: { readonly db: ProviderNeutralDatabase; readonly appHome: string }) {
      const binding = selection.skillContent
      if (binding === undefined)
        return createSkillTreeVersionParticipant({
          db: input.db,
          fs: { appHome: input.appHome },
          trees: createFileSkillTreeContentStore(input.appHome),
        })
      return createSkillTreeVersionParticipant({
        db: input.db,
        fs: {
          appHome: binding.rootReference,
          versionContent: binding.versionContent,
          versionReader: binding.versionReader,
          lifecycleContent: binding.lifecycleContent,
          deletionContent: binding.deletionContent,
        },
        trees: binding.treeContent ?? createFileSkillTreeContentStore(binding.rootReference),
      })
    },
  })
}
