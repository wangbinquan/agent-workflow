import type { ClarifyAnswerContent } from '../../domain/clarifyAnswerContent'

export interface ClarifyAnswerSource {
  readonly id: string
  readonly taskId: string
  readonly intermediaryNodeId: string
  readonly askingNodeRunId: string | null
  readonly questionsJson: string
  readonly answers: ClarifyAnswerContent
}

export interface ClarifyAnswerQueries {
  listSelfQuestions(
    ids: readonly string[],
  ): Promise<readonly Pick<ClarifyAnswerSource, 'id' | 'taskId' | 'questionsJson'>[]>
  /** 自澄清源固定按 round id 排序；每轮 answers 保持封口顺序与历史重复 occurrence。 */
  listSelfSources(ids: readonly string[]): Promise<readonly ClarifyAnswerSource[]>
}
