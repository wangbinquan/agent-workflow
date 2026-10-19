// RFC-370 §10 V17 — the task-image operation answering hosted repository remote
// reads (launch pickers, registration checks) in the release's system volume.
export { REPOSITORY_REMOTE_OPERATION } from '../infrastructure/crewstation/repositoryRemote'
export { executeRepositoryRemoteVolumeOperation as executeTaskImageRepositoryRemote } from '../infrastructure/crewstation/repositoryRemoteVolume'
