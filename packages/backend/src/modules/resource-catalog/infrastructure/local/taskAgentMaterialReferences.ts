import { join } from 'node:path'
import { ulid } from 'ulid'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { ResolvedSkill } from '@/services/runtime/types'
import type { RuntimePlugin } from '@/services/execution/agentInjection'
import type {
  TaskAgentMaterialReferences,
  TaskAgentResourceMaterial,
} from '../../application/ports/taskAgentMaterialReferences'

type MaterialSkill = TaskAgentResourceMaterial['skills'][number]
type MaterialPlugin = TaskAgentResourceMaterial['plugins'][number]
type ContentReference = AgentMaterialIntent['workspace']

/** Local content locations stay in this selected owner. Constructing the binding
 * performs no content read. Weak bindings have the invocation reference lifetime. */
export function createLocalTaskAgentMaterialReferences(input: { readonly appHome: string }) {
  const skills = new WeakMap<ContentReference, ResolvedSkill>()
  const plugins = new WeakMap<ContentReference, RuntimePlugin>()
  const references: TaskAgentMaterialReferences = {
    references(snapshot) {
      const scope = ulid()
      const skillReferences = snapshot.skills.map((skill, index): MaterialSkill => {
        const native: ResolvedSkill =
          skill.kind === 'project'
            ? { name: skill.name, sourceKind: 'project' }
            : {
                name: skill.name,
                sourceKind: 'managed',
                sourcePath: join(input.appHome, 'skills', skill.skillId, 'files'),
                skillId: skill.skillId,
                contentVersion: skill.contentVersion,
              }
        const content: ContentReference = Object.freeze({
          owner: 'resource-catalog',
          reference: `aw-task-resource:${scope}:skill:${index}`,
          version: native.contentVersion ?? null,
        })
        skills.set(content, native)
        return Object.freeze({
          name: native.name,
          sourceKind: native.sourceKind,
          ...('skillId' in native ? { skillId: native.skillId } : {}),
          ...('contentVersion' in native ? { contentVersion: native.contentVersion } : {}),
          content,
        })
      })
      const pluginReferences = snapshot.plugins.map((plugin, index): MaterialPlugin => {
        const content: ContentReference = Object.freeze({
          owner: 'resource-catalog',
          reference: `aw-task-resource:${scope}:plugin:${index}`,
          version: plugin.resolvedVersion ?? null,
        })
        plugins.set(content, plugin)
        return Object.freeze({
          declaration: Object.freeze({
            id: plugin.id,
            name: plugin.name,
            options: plugin.options,
            enabled: plugin.enabled,
          }),
          content,
        })
      })
      return Object.freeze({
        skills: Object.freeze(skillReferences),
        plugins: Object.freeze(pluginReferences),
      })
    },
  }
  return {
    references,
    /** Private native receiver passed only to the chosen local compiler. */
    contents: {
      skill(reference: MaterialSkill): ResolvedSkill {
        const value = skills.get(reference.content)
        if (value === undefined) throw new Error('task-agent-skill-content-unavailable')
        return value
      },
      plugin(reference: MaterialPlugin): RuntimePlugin {
        const value = plugins.get(reference.content)
        if (value === undefined) throw new Error('task-agent-plugin-content-unavailable')
        return value
      },
    },
  }
}
