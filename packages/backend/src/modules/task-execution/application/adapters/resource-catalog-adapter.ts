import type { SubjectTaskReferenceParticipant } from '@/modules/resource-catalog/composition/required-ports'
import type { SubjectTaskReferences } from '../ports/subjectTaskReferences'

export function composeSubjectTaskReferenceParticipant(
  references: SubjectTaskReferences,
): SubjectTaskReferenceParticipant {
  return { nonTerminalTaskIds: (subject) => references.nonTerminalTaskIds(subject) }
}
