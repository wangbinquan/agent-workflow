// RFC-190 — the merged "task activity" card: the three former standalone
// homepage sections (Waiting on you / Running / Recently finished) live on as
// sub-groups inside ONE `.homepage-section` card, freeing the first screen
// for the capability portal.
//
// Contract preservation (design.md §1 / gate P1-1): the three sub-groups
// render UNCONDITIONALLY (empty states stay per-group, no merged empty
// state), keep their `homepage-section-inbox/-running/-recent` testids and
// the inbox-above-running order, and the inbox action stays a <button> that
// flips the sidebar inbox store (never a link). The three list components
// are reused verbatim — query keys, row testids and polling cadence
// unchanged. No total count chip: the groups' numbers overlap (running
// includes awaiting_*, inbox counts actions not tasks — gate P2-4).

import { useCallback, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { setInboxOpen } from '@/stores/inbox'
import { InboxPreviewList } from './InboxPreviewList'
import { RecentlyDoneList } from './RecentlyDoneList'
import { RunningTaskList } from './RunningTaskList'

export function TaskFeed() {
  const { t } = useTranslation()
  const [inboxCount, setInboxCount] = useState(0)
  const [runningCount, setRunningCount] = useState(0)
  const [recentCount, setRecentCount] = useState(0)
  const onInboxCount = useCallback((n: number) => setInboxCount(n), [])
  const onRunningCount = useCallback((n: number) => setRunningCount(n), [])
  const onRecentCount = useCallback((n: number) => setRecentCount(n), [])

  return (
    <section className="homepage-section task-feed" data-testid="homepage-section-feed">
      <div className="homepage-section__head">
        <h2 className="homepage-section__title">{t('home.feed.title')}</h2>
      </div>
      <FeedGroup
        testId="homepage-section-inbox"
        title={t('home.section.inbox')}
        count={inboxCount}
        warn
        action={
          <button
            type="button"
            className="homepage-section__link"
            onClick={() => setInboxOpen(true)}
          >
            {t('home.section.openInbox')}
          </button>
        }
      >
        <InboxPreviewList onCount={onInboxCount} />
      </FeedGroup>
      <FeedGroup
        testId="homepage-section-running"
        title={t('home.section.running')}
        count={runningCount}
        action={
          <Link
            to="/tasks"
            search={{ status: 'running' }}
            className="homepage-section__link"
            data-testid="homepage-running-tasks-link"
          >
            {t('home.section.viewAll')}
          </Link>
        }
      >
        <RunningTaskList onCount={onRunningCount} />
      </FeedGroup>
      <FeedGroup
        testId="homepage-section-recent"
        title={t('home.section.recent')}
        count={recentCount}
        action={
          <Link
            to="/tasks"
            className="homepage-section__link"
            data-testid="homepage-all-tasks-link"
          >
            {t('home.section.viewTasks')}
          </Link>
        }
      >
        <RecentlyDoneList onCount={onRecentCount} />
      </FeedGroup>
    </section>
  )
}

interface FeedGroupProps {
  testId: string
  title: string
  count: number
  warn?: boolean
  action: ReactNode
  children: ReactNode
}

function FeedGroup({ testId, title, count, warn, action, children }: FeedGroupProps) {
  return (
    <div className="task-feed__group" data-testid={testId}>
      <div className="task-feed__group-head">
        <h3 className="task-feed__group-title">
          {title}
          <span
            className={`homepage-section__count${warn === true ? ' homepage-section__count--warn' : ''}`}
          >
            {count}
          </span>
        </h3>
        {action}
      </div>
      <div className="homepage-section__body">{children}</div>
    </div>
  )
}
