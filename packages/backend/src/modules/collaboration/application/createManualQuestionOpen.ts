// RFC-333 T7 — application command for one manual question plus its durable
// task-park obligation. Persistence details stay behind the exact writer port.

import type {
  CreateManualQuestionOpenInput,
  CreatedManualQuestionOpen,
  ManualQuestionOpenWriter,
} from './ports/manualQuestionOpenWriter'

export type { CreateManualQuestionOpenInput, CreatedManualQuestionOpen }

export class ManualQuestionOpenCreation {
  constructor(private readonly writer: ManualQuestionOpenWriter) {}

  create(input: CreateManualQuestionOpenInput): CreatedManualQuestionOpen {
    return this.writer.create(input)
  }
}
