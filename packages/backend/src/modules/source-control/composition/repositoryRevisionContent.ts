// RFC-370 §10 V16 — the standalone selection of the revision content code-review
// reads use. The hosted selection is part of the CrewStation workspace owner
// (`crewstationWorkspace.ts`); roots choose between them.
export { createLocalRepositoryRevisionContentFactory as composeLocalRepositoryRevisionContent } from '../infrastructure/local/repositoryRevisionContent'
export {
  openContainedFileWithin,
  type ContainedFileHooks,
  type ContainedRead,
} from '../infrastructure/local/containedFileRead'
