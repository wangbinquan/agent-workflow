// RFC-211 §12 — the guided-tour launcher.
//
// This page used to host an "example sandbox": press "build it for me" and the
// server created a throwaway example resource you could later wipe. The user
// decided (2026-07-21) that's redundant now that there's a real hand-holding
// tour — so this page is just a menu of learning flows. Pick one and the
// spotlight tour walks you through the REAL screens, prefilling fields as it
// goes; what you build is your own real resource, no "example" concept.

import { useTranslation } from 'react-i18next'
import { createRoute } from '@tanstack/react-router'
import { Route as rootRoute } from '@/routes/__root'
import { Card } from '@/components/Card'
import { PageHeader } from '@/components/PageHeader'
import { useTour } from '@/components/tour/SpotlightTour'
import type { TourId } from '@/components/tour/tourScript'

interface Flow {
  id: TourId
  titleKey: string
  descKey: string
}

const FLOWS: readonly Flow[] = [
  { id: 'first-task', titleKey: 'guide.track.agent', descKey: 'guide.track.agentDesc' },
  { id: 'build-workflow', titleKey: 'guide.track.workflow', descKey: 'guide.track.workflowDesc' },
  { id: 'use-workgroup', titleKey: 'guide.track.workgroup', descKey: 'guide.track.workgroupDesc' },
]

function OnboardingPage() {
  const { t } = useTranslation()
  const tour = useTour()

  return (
    <div className="page onboarding">
      <PageHeader title={t('guide.title')} data-testid="guide-page">
        <p className="page__hint">{t('guide.handholdIntro')}</p>
      </PageHeader>

      <section className="page__section">
        <div className="onboarding__flows" data-testid="guide-flows">
          {FLOWS.map((flow) => (
            <Card key={flow.id} data-testid={`guide-flow-${flow.id}`}>
              <h2 className="onboarding__flow-title">{t(flow.titleKey)}</h2>
              <p className="muted">{t(flow.descKey)}</p>
              <div className="onboarding__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid={`guide-start-${flow.id}`}
                  onClick={() => tour.start(flow.id)}
                >
                  {t('guide.startTour')}
                </button>
              </div>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
})
