# RFC-370 CI：原观测回归的三处类型配套

`0aab168136e582474a2e13e2ec1586ee094d8706` 的完整 Windows run `37926994525` 正式失败。原平台功能步骤全部成功，包括新增动态状态测试；失败在 Typecheck，三条诊断对应两份已发布的 RFC-371 测试。主流水线终态另验，不把平台步骤成功记为总绿。

`packages/frontend/tests/rfc371-report-refresh-display.test.tsx` 的两处 `getByRole('button', { name: '刷新', exact: true })` 超出当前 `ByRoleOptions`。只删除两处 `exact: true`。当前库的 role query 原本不读取这个选项，字符串 `name` 通过 `matches` 做完整相等比较；保留原字符串、点击、禁用判据、请求数量、四桶、人民币、时间、作用域和全部原断言。没有改成模糊匹配。

`packages/backend/tests/rfc371-report-snapshot-file-performance.test.ts` 的原分页循环触发 TS7022。从原有 import 地址增加已导出的 `ReportWorkingPage` 类型，对原 `page` 变量标注 `ReportWorkingPage<(typeof expectedRows)[number]['document']>`。泛型方法、唯一原 await、cursor 更新及终止条件保持，编译后运行语句不变。4501 条原记录、500 条写入批次、137 条分页、四桶求和、TEMP 数据、快照和原 WAL writer 的全部断言保持。

这是一项测试类型配套：不改生产、workflow、架构产物或原预算，不新增 census，不运行本机 AW tests、typecheck、build、services 或 E2E。两份原正文保存后按当前全文编辑，独立核对完整 inverse 与有限静态差额；共享并行输出保持。

有限独立功能门、精确发布及新 SHA 的完整主／Windows CI 分别验收。原 `0aab1681` 失败和历史失败保留，仍需核验新 SHA 的 107 条动态状态结果。总绿前不恢复新的生命周期生产实施；H7／A-T7／A-G、CS adapters 与 M0～M4 部署继续开放，AW 尚未部署 CS，RFC 未完成。
