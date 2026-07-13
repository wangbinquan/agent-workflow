// RFC-151 PR-1 — capability object for the skill detail page.
//
// /skills/$name used to gate seven UI decisions on a raw
// `sourceKind === 'managed'` boolean, which scattered the *meaning* of
// "managed" (what a managed skill is allowed to do) across the component.
// This module names each ability once; the page reads capability bits and
// never re-derives them. Pure data → unit-testable as a table.
//
// RFC-170 (G5-P2) — capabilities are now a pure function of `authorityKind`
// (the stable content-authority discriminator), not the coarse `sourceKind`.
// This splits the two external flavours the old boolean could not tell apart:
// a `source-external` skill's metadata is owned by its source dir (no
// description edit, no owner transfer), while a `hand-external` skill's DB
// metadata IS editable (still no owner transfer — the importer controls the
// on-disk content). `authorityKindOf` bridges pre-RFC-170 payloads that only
// carry `sourceKind`.

import type { Skill, SkillAuthorityKind, SkillSourceKind } from '@agent-workflow/shared'

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
  /**
   * RFC-170 §8 — the DB `description` is editable. True for managed (snapshot
   * authority) and hand-external (DB metadata authority); false for
   * source-external (the registered source dir owns the metadata).
   */
  canEditDescription: boolean
  /** RFC-170 — the skill can be deleted (all three authorities allow it). */
  canDelete: boolean
  /**
   * RFC-170 §8 (G3-2) — ACL ownership can be transferred. ONLY managed skills:
   * an external skill's injected body comes from a mutable path the original
   * registrar/importer controls, so transferring the ACL owner would be a false
   * promise (backend also rejects it — this only gates the UI control). Grant /
   * visibility edits stay allowed regardless.
   */
  canTransferOwner: boolean
}

/**
 * Resolve the authority discriminator, falling back for pre-RFC-170 payloads
 * that only carry the coarse `sourceKind`: managed → 'managed', external →
 * 'hand-external' (the more-permissive external flavour — description stays
 * editable; owner transfer is blocked for BOTH external flavours anyway).
 */
export function authorityKindOf(skill: {
  sourceKind: SkillSourceKind
  authorityKind?: SkillAuthorityKind
}): SkillAuthorityKind {
  if (skill.authorityKind !== undefined) return skill.authorityKind
  return skill.sourceKind === 'managed' ? 'managed' : 'hand-external'
}

export function skillCapabilities(authorityKind: SkillAuthorityKind): SkillCapabilities {
  const managed = authorityKind === 'managed'
  return {
    canFuse: managed,
    canEditContent: managed,
    canBrowseFilesWritable: managed,
    showManagedHint: managed,
    showVersionHistory: managed,
    // Description: managed + hand-external editable; source-external is not.
    canEditDescription: managed || authorityKind === 'hand-external',
    canDelete: true,
    // Owner transfer: managed only (external content controller ≠ ACL owner).
    canTransferOwner: managed,
  }
}

/** Convenience: capabilities straight off a `Skill` row (resolves authority). */
export function skillCapabilitiesOf(skill: Skill): SkillCapabilities {
  return skillCapabilities(authorityKindOf(skill))
}
