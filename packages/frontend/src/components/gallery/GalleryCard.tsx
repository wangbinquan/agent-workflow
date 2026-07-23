// RFC-191 (T2) — one gallery card (workflows / workgroups list pages).
//
// Built ON the shared <Card> primitive (RFC-124): body = title row +
// description + meta chips, footer = relative time + the single inline
// action（启动）. The whole card is clickable via the stretched-link pattern —
// the title is a REAL <Link> whose ::after overlay covers the card, and only
// `.gallery-card__ops` is raised above it, so the DOM never nests <a> in <a>.
// Badges/meta stay UNDER the overlay on purpose (clicking them = opening the
// card; no dead zones — RFC-191 design §1.2, Codex 设计门 P2-8).

import { useId } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Card } from '@/components/Card'
import { WORKFLOW_ICON, WORKGROUP_ICON } from '@/components/icons/resourceIcons'
import { RelativeTime } from '@/components/RelativeTime'

/** The task-wizard deep-link payloads the launch button may carry
 *  (`tasks.new.tsx` validateSearch contract). */
export type GalleryLaunchSearch =
  | { kind: 'workflow'; workflow: string }
  | { kind: 'workgroup'; workgroupId: string }

interface GalleryCardItemBase {
  key: string
  title: string
  /** Filter text + card description (one source; empty string treated as absent). */
  subtitle?: string
  /** Additional visible card facts that should participate in local search. */
  searchText?: string
  /** Italic fallback rendered when `subtitle` is absent (i18n'd by the page). */
  subtitleFallback: string
  /** Title-row badges (ResourceBadges / chips), assembled by the page. */
  badges?: ReactNode
  /** Meta chips row (version / node count / mode / members …). */
  meta?: ReactNode
  /** Footer-left timestamp (epoch ms). */
  updatedAt: number
  /** Compact launch-readiness explanation or advisory. */
  actionHint?: string
  testid?: string
}

export interface WorkflowGalleryCardItem extends GalleryCardItemBase {
  /** Drives the resource glyph + restrained per-resource accent treatment. */
  kind: 'workflow'
  to: '/workflows/$id'
  params: { id: string }
  launch?: Extract<GalleryLaunchSearch, { kind: 'workflow' }>
}

export interface WorkgroupGalleryCardItem extends GalleryCardItemBase {
  /** Drives the resource glyph + restrained per-resource accent treatment. */
  kind: 'workgroup'
  to: '/workgroups/$id'
  params: { id: string }
  launch?: Extract<GalleryLaunchSearch, { kind: 'workgroup' }>
}

/** Route, params, glyph and launch payload stay correlated at compile time. */
export type GalleryCardItem = WorkflowGalleryCardItem | WorkgroupGalleryCardItem

export function GalleryCard({ item }: { item: GalleryCardItem }): ReactElement {
  const { t } = useTranslation()
  const descriptionId = useId()
  const updatedId = useId()
  const hasSubtitle = item.subtitle !== undefined && item.subtitle !== ''
  const visibleDescription =
    item.subtitle !== undefined && item.subtitle !== '' ? item.subtitle : item.subtitleFallback
  const absoluteUpdatedAt = new Date(item.updatedAt).toLocaleString()
  // The stretched link owns pointer hover across the card. Mirror the clamped
  // description and absolute timestamp onto its native tooltip so those two
  // RFC-191 details remain discoverable even though their visual nodes sit
  // underneath the overlay; aria-describedby exposes the same context to AT.
  const cardTooltip = `${item.title}\n${visibleDescription}\n${t('common.updated')}: ${absoluteUpdatedAt}`
  const kindLabel = t(item.kind === 'workflow' ? 'workflows.cardKind' : 'workgroups.cardKind')
  const kindIcon = item.kind === 'workflow' ? WORKFLOW_ICON : WORKGROUP_ICON
  return (
    <Card
      interactive
      className={`gallery-card gallery-card--${item.kind}`}
      data-testid={item.testid}
      footer={
        <div className="gallery-card__foot">
          <span id={updatedId} className="gallery-card__when">
            <span className="gallery-card__when-label">{t('common.updated')}</span>
            <RelativeTime ts={item.updatedAt} />
          </span>
          <span
            className={`gallery-card__ops${item.launch === undefined ? ' gallery-card__ops--passive' : ''}`}
          >
            {item.actionHint !== undefined && (
              <span className="gallery-card__action-hint">
                <span className="gallery-card__action-dot" aria-hidden="true" />
                {item.actionHint}
              </span>
            )}
            {item.launch !== undefined && (
              <Link
                to="/tasks/new"
                search={item.launch}
                className="btn btn--sm btn--primary"
                aria-label={t('common.launchResource', { name: item.title })}
                data-testid={item.testid !== undefined ? `${item.testid}-launch` : undefined}
              >
                {t('common.launch')}
                <span className="gallery-card__launch-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            )}
          </span>
        </div>
      }
    >
      <div className="gallery-card__head">
        <span className="gallery-card__icon" aria-hidden="true">
          {kindIcon}
        </span>
        <div className="gallery-card__identity">
          <span className="gallery-card__kind">{kindLabel}</span>
          <div className="gallery-card__title">
            <Link
              to={item.to}
              params={item.params}
              className="gallery-card__stretch gallery-card__name"
              title={cardTooltip}
              aria-describedby={`${descriptionId} ${updatedId}`}
            >
              {item.title}
            </Link>
            {item.badges != null && item.badges !== false && (
              <span className="gallery-card__badges chip-row">{item.badges}</span>
            )}
          </div>
        </div>
      </div>
      {hasSubtitle ? (
        <p id={descriptionId} className="gallery-card__desc" title={item.subtitle}>
          {item.subtitle}
        </p>
      ) : (
        <p id={descriptionId} className="gallery-card__desc gallery-card__desc--empty">
          {item.subtitleFallback}
        </p>
      )}
      {item.meta != null && item.meta !== false && (
        <div className="gallery-card__meta chip-row">{item.meta}</div>
      )}
    </Card>
  )
}
