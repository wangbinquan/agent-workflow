// RFC-304 — inspector panel for the synthesized `code-round` node.
//
// There is nothing to edit here, and that is the point. A code-round node is
// synthesized by `startCodeRoundTask`; the stage sequence it runs is platform
// code (written down, versioned, NOT user-authorable — proposal §3.3), and what
// each stage uses is configured one level up in the capability binding, not on
// the node.
//
// A user only ever reaches this panel by opening the snapshot of an already-run
// task. So the panel states plainly what this node is and where the knobs
// actually live, rather than rendering an empty form that invites the reader to
// look for controls that do not exist.

import { useTranslation } from 'react-i18next'
import { NoticeBanner } from '@/components/NoticeBanner'
import type { EditProps } from './types'

export function CodeRoundEdit({ node }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const capability = typeof rec.capability === 'string' ? rec.capability : null
  return (
    <div className="inspector-section" data-testid="code-round-edit">
      <NoticeBanner tone="info">{t('codeRoundNode.notEditable')}</NoticeBanner>
      {capability !== null ? (
        <p className="inspector-hint" data-testid="code-round-edit-capability">
          {t('codeRoundNode.capabilityHint', { capability })}
        </p>
      ) : null}
    </div>
  )
}
