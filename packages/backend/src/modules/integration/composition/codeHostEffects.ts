// integration 装配：开发交付的代码托管桥（RFC-310 PR-5 T60；RFC-471 起归 integration）。
//
// RFC-502（RFC-294 S10 第九步）：绑定、MR effects、MR 原始事实与仓库认领键的实现迁入
// `application/developmentCodeHostDelivery.ts`；这里只把它们接在同一个绑定上，装配根注入 development-automation 的端口。

import {
  createDevelopmentCodeHostBinding,
  createDevelopmentMrEffects,
  createDevelopmentMrFactsSource,
  createRepositoryCodeHostClaimKeys,
} from '../application/developmentCodeHostDelivery'

/**
 * RFC-471: the development delivery's code-host side in one assembly — the binding and the three
 * capabilities built on it (the assembly root injects them into development-automation's ports).
 */
export function composeDevelopmentCodeHostDelivery(
  input: Parameters<typeof createDevelopmentCodeHostBinding>[0],
) {
  const binding = createDevelopmentCodeHostBinding(input)
  return Object.freeze({
    binding,
    mrEffects: createDevelopmentMrEffects({ binding }),
    mrFacts: createDevelopmentMrFactsSource({ binding }),
    claimKeys: createRepositoryCodeHostClaimKeys({ binding }),
  })
}
