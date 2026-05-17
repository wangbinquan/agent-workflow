// RFC-023 PR-C T21 — "Recommended" chip rendered next to the question
// title when ClarifyQuestion.recommended is true. Small visual unit so the
// QuestionForm body stays focused on input plumbing.

import { useTranslation } from 'react-i18next'

export function RecommendedChip() {
  const { t } = useTranslation()
  return (
    <span className="clarify-recommended-chip" data-testid="clarify-recommended-chip">
      {t('clarify.detail.recommendedChip')}
    </span>
  )
}
