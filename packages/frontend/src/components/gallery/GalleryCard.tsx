// RFC-191 (T2) — one gallery card (workflows / workgroups list pages).
//
// Built ON the shared <Card> primitive (RFC-124): body = title row +
// description + meta chips, footer = relative time + the single inline
// action（启动）. The whole card is clickable via the stretched-link pattern —
// the title is a REAL <Link> whose ::after overlay covers the card, and only
// `.gallery-card__ops` is raised above it, so the DOM never nests <a> in <a>.
// Badges/meta stay UNDER the overlay on purpose (clicking them = opening the
// card; no dead zones — RFC-191 design §1.2, Codex 设计门 P2-8).

import type { ReactElement, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { RelativeTime } from '@/components/RelativeTime'

/** The task-wizard deep-link payloads the launch button may carry
 *  (`tasks.new.tsx` validateSearch contract). */
export type GalleryLaunchSearch =
  | { kind: 'workflow'; workflow: string }
  | { kind: 'workgroup'; workgroup: string }

export interface GalleryCardItem {
  key: string
  title: string
  /** Filter text + card description (one source; empty string treated as absent). */
  subtitle?: string
  /** Italic fallback rendered when `subtitle` is absent (i18n'd by the page). */
  subtitleFallback: string
  /** Title-row badges (ResourceBadges / chips), assembled by the page. */
  badges?: ReactNode
  /** Meta chips row (version / node count / mode / members …). */
  meta?: ReactNode
  /** Footer-left timestamp (epoch ms). */
  updatedAt: number
  to: '/workflows/$id' | '/workgroups/$name'
  params: { id: string } | { name: string }
  /** Footer-right「启动」deep link; omit to hide (e.g. not-ready workgroups). */
  launch?: GalleryLaunchSearch
  testid?: string
}

export function GalleryCard({ item }: { item: GalleryCardItem }): ReactElement {
  const { t } = useTranslation()
  const hasSubtitle = item.subtitle !== undefined && item.subtitle !== ''
  return (
    <Card
      interactive
      className="gallery-card"
      data-testid={item.testid}
      footer={
        <div className="gallery-card__foot">
          <span className="gallery-card__when">
            <RelativeTime ts={item.updatedAt} />
          </span>
          <span className="gallery-card__ops">
            {item.launch !== undefined && (
              <Link
                to="/tasks/new"
                search={item.launch}
                className="btn btn--sm btn--primary"
                data-testid={item.testid !== undefined ? `${item.testid}-launch` : undefined}
              >
                {t('common.launch')}
              </Link>
            )}
          </span>
        </div>
      }
    >
      <div className="gallery-card__title">
        <Link
          to={item.to}
          params={item.params}
          className="gallery-card__stretch gallery-card__name"
          title={item.title}
        >
          {item.title}
        </Link>
        {item.badges != null && item.badges !== false && (
          <span className="gallery-card__badges chip-row">{item.badges}</span>
        )}
      </div>
      {hasSubtitle ? (
        <p className="gallery-card__desc" title={item.subtitle}>
          {item.subtitle}
        </p>
      ) : (
        <p className="gallery-card__desc gallery-card__desc--empty">{item.subtitleFallback}</p>
      )}
      {item.meta != null && item.meta !== false && (
        <div className="gallery-card__meta chip-row">{item.meta}</div>
      )}
    </Card>
  )
}
