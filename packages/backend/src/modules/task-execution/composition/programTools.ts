// RFC-370 §10 V19 — program tool selections for the composition roots: where a
// program's frozen source is read from and where its contract fixture runs.
// A standalone root keeps the defaults (application home, this host); the
// hosted root hands in the selected program store and the task-image fixture.
export {
  createArtifactProgramToolSource,
  type ProgramArtifactReader,
} from '../infrastructure/adapters/programArtifactToolSource'
export { createHostedScriptFixtureProcess } from '../infrastructure/crewstation/scriptFixtureProcess'
export type { ProgramToolSource, ScriptFixtureProcess } from '../application/ports/scriptFixture'
