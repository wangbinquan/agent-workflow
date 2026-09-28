import type { Config } from '@agent-workflow/shared'

/** Current deployment values used by endpoint presentation and trigger admission. */
export interface WebhookConfigurationQuery {
  read():
    | Pick<Config, 'publicBaseUrl' | 'defaultRuntime'>
    | Promise<Pick<Config, 'publicBaseUrl' | 'defaultRuntime'>>
}
