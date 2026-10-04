# 已收到用量与泳道修复的正式 CI 后继

`38572c666365e0d5542af421a6b849117f874eca` 的 Windows `37206764230` 正式失败。四处错误分别为：新增趋势测试只传 tab 却声明完整 ObservationSearch；span 拒绝回归的闭包未保留 facts 窄化；quality 回归误将 Task 身份放在不接受该字段的 overview query；独立指标 Map 读取仍可能 undefined。原日志保留，不改记为通过。

有限修复分别传原 fixture 默认的完整时间范围；先保存同一已验证 facts 的 gaps；沿实际 service.request 第四个 taskId 参数取得真正独立的原 Task 生命周期报告；在对拍前明确拒绝缺独立指标。202 Task、201 缺 invocation 人口、37 续页至 EOF、全部原因和四桶拒绝、旧索引拒绝、双 provider 及原60000ms预算均保持，不能用全范围报告代替独立 Task。

同 SHA 视觉 `37206563345` 正式失败在 daemon ready 之前。原 stderr 为 `Failed to start server. Is port 39309 in use?`，现有 harness 只识别 EADDRINUSE / address already in use，因此已有三次新端口重试未发生。后继只识别这一准确的 Bun 端口占用诊断，继续先结束原失败 child 再申请新 OS 端口。原三次上限、ready 等待、home 归属清理、实际浏览器断言与其时间预算全部保持；其他启动错误继续立即失败。新增正常第三次启动、三次碰撞终态及非碰撞一次拒绝的真实 fake-child 生命周期回归。

本片不改变生产用量协议、报表人口、采集完整资格、人民币或泳道页面行为。只做有限实现门、精确 format/lint 和静态内容核对；用例及全仓结论继续使用新确切 SHA hosted CI。原失败与取消历史、并行开发和 native owner／规模未完成项保持；两个 RFC 仍进行中。

首 SOURCE6 留存唯一 P2／FAIL：quality 测试 build 仍只给 Task facts 工厂传 executor，独立请求的真实 Task 身份没有进入原 population 的闭包 seed。窄后继只补 `createCompleteTaskObservationFacts(snapshot.executor, report.request.taskId)`，使全窗请求仍有202任务，单 Task 原生命周期请求恰为1任务；原 population、递归子任务、分页及所有断言／预算不变。其余四项已核增量保持字节相同，有限后继门单独留证，不改写原失败。
