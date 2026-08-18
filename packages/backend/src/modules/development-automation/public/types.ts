// RFC-310 development-automation public types。
//
// 按 RFC-294 §3.3：public symbol 只在出现真实跨 context consumer 时导出；
// 骨架期零消费者，本入口刻意为空——不要预放通用 CRUD/DTO。首个真实
// consumer 出现时（PR-2+），逐 symbol 登记 owner/direction/consumer 再导出。
export {}
