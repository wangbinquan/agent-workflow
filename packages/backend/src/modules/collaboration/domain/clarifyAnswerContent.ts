import type { ClarifyAnswer } from '@agent-workflow/shared'

/** 历史非数组 / 损坏载荷单独表示，蒸馏继续显示原有内容，不能静默变成 []。 */
export type ClarifyAnswerContent =
  | { readonly kind: 'absent' }
  | { readonly kind: 'answers'; readonly values: readonly ClarifyAnswer[] }
  | { readonly kind: 'legacy-value'; readonly json: string }
  | { readonly kind: 'malformed'; readonly text: string }

export function clarifyAnswerContentForPrompt(content: ClarifyAnswerContent): string {
  switch (content.kind) {
    case 'absent':
      return '[]'
    case 'answers':
      return JSON.stringify(content.values)
    case 'legacy-value':
      return content.json
    case 'malformed':
      return content.text
  }
}
