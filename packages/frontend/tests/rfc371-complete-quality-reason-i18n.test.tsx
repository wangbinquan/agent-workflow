// RFC-371: the formal quality dialog explains known native gaps in both UI languages.
// The real page exposed these two original reasons as untranslated internal codes.
import { createRef } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CompleteQualityDetails } from '../src/components/observability/CompleteObservationQuality'
import { observationGapLabel } from '../src/components/observability/observationGapLabel'
import i18n from '../src/i18n'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('zh-CN')
})

const reasons = [
  {
    code: 'native-capture-incomplete',
    zh: '原生采集记录不完整',
    en: 'Native capture records are incomplete',
  },
  {
    code: 'native-step-unfinished',
    zh: '原生步骤缺少结束记录',
    en: 'A native step lacks its completion record',
  },
] as const

for (const reason of reasons) {
  for (const language of ['zh-CN', 'en-US'] as const) {
    test(`${language} explains ${reason.code} in the actual detail dialog`, async () => {
      await i18n.changeLanguage(language)
      const label = language === 'zh-CN' ? reason.zh : reason.en
      render(
        <CompleteQualityDetails
          row={{ key: reason.code, taskCount: '5', taskIndexVersion: 1 }}
          onClose={vi.fn()}
          triggerRef={createRef<HTMLElement>()}
          fallbackRef={createRef<HTMLElement>()}
        >
          <p>original task association count: 5</p>
        </CompleteQualityDetails>,
      )
      const dialog = screen.getByRole('dialog', { name: new RegExp(label) })
      expect(within(dialog).getByText('original task association count: 5')).toBeTruthy()
      expect(screen.queryByText(reason.code, { exact: true })).toBeNull()
      expect(dialog.textContent).toContain(label)
    })
  }
}

test('a new original gap is retained when its translation is not registered', async () => {
  const original = 'future-original-native-gap'
  for (const language of ['zh-CN', 'en-US']) {
    await i18n.changeLanguage(language)
    expect(observationGapLabel(original, i18n.getFixedT(language))).toBe(original)
  }
})
