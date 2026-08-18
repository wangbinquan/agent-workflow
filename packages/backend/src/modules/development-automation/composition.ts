// development-automation 装配入口（RFC-310）。
//
// 仅装配点可 import 本文件；它只做实例化与注入——不查 DB、不做业务
// if/switch、不翻译 DTO（RFC-294 §2）。当前为骨架：PR-2 接入 Mission
// aggregate/worker 时在此装配并登记首个消费者（消费者账本见
// rfc310-architecture-lock.test.ts，增删一条都要显式修订）。
export interface DevelopmentAutomationModule {
  /** 骨架占位：PR-1/PR-2 起挂 commands/queries/worker 构造结果。 */
  readonly ready: true
}

export function composeDevelopmentAutomation(): DevelopmentAutomationModule {
  return { ready: true }
}
