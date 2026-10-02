import type { Skill } from '@agent-workflow/shared'

/** Storage answers only whether the exact immutable version exists. */
export interface SkillVersionPresenceQueries {
  exists(reference: {
    readonly id: string
    readonly contentVersion: number
  }): boolean | Promise<boolean>
}

/** AW combines storage facts with its existing boot availability predicate. */
export interface SkillContentAvailability {
  isAvailable(skill: Skill): Promise<boolean>
}
