import { QueryClientContext, QueryObserver } from '@tanstack/react-query'
import { useContext, useEffect, useMemo, useState } from 'react'

import { api } from '@/api/client'
import type { RuntimeTriggerParameterContract } from '@/components/runtime-parameters/catalog'

const EVENT_CATALOG_QUERY_KEY = ['event-center', 'catalog'] as const

type LocalizedText = { 'zh-CN': string; 'en-US': string }
type EventCatalog = {
  sources: Array<{
    sourceRef: { id: string; revision: number }
    displayName: LocalizedText
    description: LocalizedText
  }>
  eventTypes: Array<{
    eventTypeRef: { id: string; revision: number }
    sourceRef: { id: string; revision: number }
    displayName: LocalizedText
    description: LocalizedText
    triggerParameters: {
      namespace: string
      fields: Array<{
        fieldId: string
        displayName: LocalizedText
        description: LocalizedText
      }>
    } | null
  }>
}

function text(value: LocalizedText, language: string): string {
  return language.startsWith('zh') ? value['zh-CN'] : value['en-US']
}

/**
 * Provider-tolerant projection of Event Center contracts for the workflow
 * editor. Production reads the live catalog; isolated inspector tests without
 * a QueryClient simply expose no global trigger parameters.
 */
export function useEventTriggerContracts(language: string): RuntimeTriggerParameterContract[] {
  const client = useContext(QueryClientContext)
  const [catalog, setCatalog] = useState<EventCatalog | undefined>(() =>
    client?.getQueryData<EventCatalog>(EVENT_CATALOG_QUERY_KEY),
  )
  useEffect(() => {
    if (client === undefined) return
    const observer = new QueryObserver<EventCatalog>(client, {
      queryKey: [...EVENT_CATALOG_QUERY_KEY],
      queryFn: ({ signal }) => api.get('/api/event-center/catalog', undefined, signal),
    })
    setCatalog(observer.getCurrentResult().data)
    return observer.subscribe((result) => setCatalog(result.data))
  }, [client])

  return useMemo(() => {
    if (!Array.isArray(catalog?.eventTypes) || !Array.isArray(catalog.sources)) return []
    return catalog.eventTypes.flatMap((event): RuntimeTriggerParameterContract[] => {
      if (event.triggerParameters === null) return []
      const source = catalog.sources.find(
        (candidate) =>
          candidate.sourceRef.id === event.sourceRef.id &&
          candidate.sourceRef.revision === event.sourceRef.revision,
      )
      return [
        {
          namespace: event.triggerParameters.namespace,
          definitionRef: event.eventTypeRef,
          sourceLabel:
            source === undefined ? event.sourceRef.id : text(source.displayName, language),
          sourceDescription: source === undefined ? undefined : text(source.description, language),
          groupLabel: text(event.displayName, language),
          fields: event.triggerParameters.fields.map((field) => ({
            fieldId: field.fieldId,
            label: text(field.displayName, language),
            description: text(field.description, language),
          })),
        },
      ]
    })
  }, [catalog, language])
}
