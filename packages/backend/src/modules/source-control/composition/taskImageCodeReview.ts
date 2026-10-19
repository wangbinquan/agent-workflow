// RFC-370 §10 V16 — the task-image operation answering hosted code-review reads.
export { CODE_REVIEW_OPERATION as TASK_IMAGE_CODE_REVIEW_OPERATION } from '../infrastructure/crewstation/codeReviewProtocol'
export { executeCodeReviewVolumeOperation as executeTaskImageCodeReview } from '../infrastructure/crewstation/codeReviewVolumeOperation'
