// P-5-03 stage 1: i18next + react-i18next bootstrap.
//
// Default language is zh-CN (matches `Config.language` default). The detector
// reads `localStorage.aw-language` first, then the browser navigator.language.
//
// Usage:
//   import { useTranslation } from 'react-i18next'
//   const { t } = useTranslation()
//   <span>{t('nav.agents')}</span>
//
// For backend ApiError → user-facing message, use `describeApiError` below.

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { enUS } from './en-US'
import { zhCN } from './zh-CN'
import { resolveApiError } from './errors'

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const LANG_STORAGE_KEY = 'aw-language'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  })

export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang)
}

/**
 * Map a backend ApiError to a human-facing message in the current locale.
 * Unknown codes fall back to the raw `message` field, prefixed with the
 * generic 'fallback' string. This keeps stack-trace-style codes useful for
 * debugging while still showing something readable in the UI.
 */
export function describeApiError(err: unknown): string {
  // RFC-203 T1: thin string-only shell over the three-tier resolver. Exact /
  // override matches are self-sufficient localized sentences; the domain and
  // fallback tiers keep `: <raw backend message>` appended so surfaces that
  // render a single string (form rows, dialogs not yet on ErrorBanner) never
  // lose the only diagnostic — the rich ErrorBanner path folds `raw` into a
  // collapsible block instead.
  const r = resolveApiError(err)
  if (r.matched === 'exact' || r.matched === 'override') return r.title
  return r.raw !== undefined && r.raw !== '' && r.raw !== r.title ? `${r.title}: ${r.raw}` : r.title
}

export default i18n
