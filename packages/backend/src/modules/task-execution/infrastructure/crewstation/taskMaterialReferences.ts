// RFC-417: hosted (CrewStation) task material references, moved verbatim from
// composition/crewstationTaskRunSelection.ts (`hosted-skill:` / `project-skill:` references, `file://` plugins).
import type { TaskAgentMaterialReferences } from '@/modules/resource-catalog/public/participants'

/** Preserve frozen content generations when a resource is updated during a run. */
export function createHostedTaskMaterialReferences(): TaskAgentMaterialReferences {
  return {
    references(snapshot) {
      return {
        skills: snapshot.skills.map((skill) => ({
          name: skill.name,
          sourceKind: skill.kind,
          ...(skill.kind === 'managed'
            ? { skillId: skill.skillId, contentVersion: skill.contentVersion }
            : {}),
          content: {
            owner: 'resource-catalog',
            reference:
              skill.kind === 'managed'
                ? `hosted-skill:${skill.skillId}`
                : `project-skill:${skill.name}`,
            version: skill.kind === 'managed' ? skill.contentVersion : null,
          },
        })),
        plugins: snapshot.plugins.map((plugin) => ({
          declaration: {
            id: plugin.id,
            name: plugin.name,
            options: plugin.options,
            enabled: plugin.enabled,
          },
          content: {
            owner: 'resource-catalog',
            reference: plugin.runtimeSpecifier.startsWith('file://')
              ? plugin.runtimeSpecifier.slice(7)
              : plugin.runtimeSpecifier,
            version: plugin.resolvedVersion ?? null,
          },
        })),
      }
    },
  }
}
