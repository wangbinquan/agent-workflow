// RFC-370 v3 V8 — copy for code-host events in a CrewStation-hosted deployment:
// events arrive only through CrewStation's event delivery (there is no direct
// webhook address), and a delegated delivery names the platform event and
// deliveries an operator can trace in CrewStation.
export interface HostedEventMessages {
  endpointTitle: string
  endpoint: string
  endpointId: string
  platformEvent: string
  platformDeliveries: string
  platformDelivery: string
}

export const hostedEventsZh: HostedEventMessages = {
  endpointTitle: '事件经 CrewStation 投递',
  endpoint:
    '托管部署没有直连 Webhook 地址。代码平台事件由 CrewStation 的事件订阅投递：请平台管理员在部署的事件来源配置（AW_EVENT_SOURCES）中把仓库绑定到下面的端点 ID；通道为 crewstation 时触发器照常处理，为 shadow 时只记录不触发。',
  endpointId: '端点 ID',
  platformEvent: '平台事件',
  platformDeliveries: '平台投递',
  platformDelivery: '{{deliveryId}} · 第 {{attempt}} 次尝试',
}

export const hostedEventsEn: HostedEventMessages = {
  endpointTitle: 'Events arrive through CrewStation',
  endpoint:
    'A hosted deployment has no direct webhook address. Code-host events are delivered by CrewStation event subscriptions: ask a platform administrator to bind repositories to the endpoint ID below in the deployment event-source configuration (AW_EVENT_SOURCES). With the crewstation channel triggers run as usual; with the shadow channel deliveries are only recorded.',
  endpointId: 'Endpoint ID',
  platformEvent: 'Platform event',
  platformDeliveries: 'Platform deliveries',
  platformDelivery: '{{deliveryId}} · attempt {{attempt}}',
}
