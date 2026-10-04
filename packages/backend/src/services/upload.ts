// RFC-370: exact compatibility exports; Task owns upload policy, SC owns content effects.
export {
  DEFAULT_UPLOAD_LIMITS,
  sniffMime,
  acceptMatches,
  validateUploadPlan,
} from '@/modules/task-execution/public/queries'
export type {
  UploadLimits,
  UploadInputDef,
  UploadFile,
} from '@/modules/task-execution/public/types'
export { assertInsideWorktree } from '@/platform/content/local/uploadPaths'
export {
  applyUploadsToWorktree,
  resolveUniqueName,
  type UploadPlan,
  type UploadResult,
} from '@/platform/content/local/workspaceUploads'
