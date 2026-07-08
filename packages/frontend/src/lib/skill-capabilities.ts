// RFC-151 PR-1 — capability object for the skill detail page.
//
// /skills/$name used to gate seven UI decisions on a raw
// `sourceKind === 'managed'` boolean, which scattered the *meaning* of
// "managed" (what a managed skill is allowed to do) across the component.
// This module names each ability once; the page reads capability bits and
// never re-derives them. Pure data → unit-testable as a table.

import type { SkillSourceKind } from '@agent-workflow/shared'

export interface SkillCapabilities {
  /** Fusion (memories → skill) can target this skill (launch button shown). */
  canFuse: boolean
  /** SKILL.md body is editable: MarkdownEditor rendered + content PUT on save. */
  canEditContent: boolean
  /** File tree is writable (upload / delete); false renders it read-only. */
  canBrowseFilesWritable: boolean
  /** Description field shows the managed phrasing of its hint. */
  showManagedHint: boolean
  /** Version history section is rendered. */
  showVersionHistory: boolean
}

export function skillCapabilities(sourceKind: SkillSourceKind): SkillCapabilities {
  const managed = sourceKind === 'managed'
  return {
    canFuse: managed,
    canEditContent: managed,
    canBrowseFilesWritable: managed,
    showManagedHint: managed,
    showVersionHistory: managed,
  }
}
