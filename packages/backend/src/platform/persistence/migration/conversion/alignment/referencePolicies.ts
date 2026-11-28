import type { ReferenceKeepPolicy } from '../rule'

/**
 * RFC-626 §3.3 "悬空行", §3.4 rows 11 / 11b: references of the alignment tables that the
 * referring row survives without. One constant serves both places that apply them: the
 * alignment contribution declares it as `references` (the target finalize applies it when the
 * referenced row was set aside during the conversion), and the alignment rules apply the same
 * entry when the referenced row is already absent from the source. The referring row therefore
 * ends up the same whichever way the referenced row dropped out.
 *
 * Foreign keys the target declares `onDelete: 'set null'` — `users_created_by_fk` among them —
 * are detached without an entry here, in both places.
 */
export const alignmentReferencePolicies: readonly ReferenceKeepPolicy[] = [
  // A reopened mission stays when the mission it was reopened from is gone.
  {
    table: 'development_missions',
    foreignKey: 'development_missions_reopened_from_fk',
    action: { kind: 'detach' },
  },
  // `added_by` is not nullable: a collaborator keeps the membership, attributed to the system.
  {
    table: 'task_collaborators',
    foreignKey: 'task_collaborators_added_by_fk',
    action: { kind: 'substitute', values: { added_by: '__system__' } },
  },
]
