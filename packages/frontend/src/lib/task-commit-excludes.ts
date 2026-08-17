import { TaskCommitExcludePatternsSchema } from '@agent-workflow/shared'

export function taskCommitExcludePatternsFromText(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== '')
}

export function taskCommitExcludePatternsToText(patterns: readonly string[]): string {
  return patterns.join('\n')
}

export function taskCommitExcludePatternsAreValid(patterns: readonly string[]): boolean {
  return TaskCommitExcludePatternsSchema.safeParse(patterns).success
}
