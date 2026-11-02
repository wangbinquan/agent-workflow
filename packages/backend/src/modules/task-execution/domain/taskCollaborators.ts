// RFC-420 — the task's collaborator projection for one drive, moved verbatim from the execution state assembly
// (`composition/taskEngineApplication.ts`).

/** The collaborator user ids: the owner row and rows without a user are left out, duplicates keep their first place. */
export function collaboratorUserIdsOf(
  members: readonly { readonly userId: string | null; readonly role: string }[],
): string[] {
  return [
    ...new Set(
      members
        .filter((member) => member.role !== 'owner' && member.userId !== null)
        .map((member) => member.userId as string),
    ),
  ]
}
