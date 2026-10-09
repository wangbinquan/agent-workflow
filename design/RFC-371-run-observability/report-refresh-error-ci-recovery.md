# RFC-371：统计刷新失败后的重试与正式 CI 回归修复

原 `7edd208a` 主 CI 与包含它的 `0aab1681` Windows/前端作业均保留正式失败；本片处理原观测修复暴露出的具体问题，不重新触发规模 CI，不以本机测试代签。

## 错误后重试

新报告 GET 返回 502 时，QueryClient 会保留最近一次 building 数据并将实际请求置为 error。原 busy 和轮询只看旧 data.state，导致刷新仍禁用并继续自动请求。已有“HTTP 错误不能复活旧统计”真实回归因此无法提交第三个报告。

只在既有 `completeReportClient.ts` 更正两处状态判断：错误终态停止自动轮询；busy 仅在 pending、实际 fetching，或没有错误且报告仍 building 时成立。实际错误时旧数字立即清除，允许原刷新按钮增加 revision 并用原 POST 生成新报告。原 scopes、refreshKey、四桶、CNY、GET/POST、细节失效、EOF 和正常 building 的禁用均保持。回归在已有错误用例中明确断言刷新恢复可用、新报告仍没有旧数、原第三次 POST 成立，不更改旧时间预算。

## 原正式组件回归

总人民币卡和维度卡都正确显示同一个金额，原全页面金额查询误报多匹配。将原四个金额查询限定原人民币总卡，保留金额/四桶/时间/柱/禁用/POST/替换的所有判据。旧完整组件用例只等新 POST 受理就点击旧快照 Agent；随后原新报告替换使旧报告的 dialog 失去显示资格。增加等待原刷新按钮恢复可用，再沿原“新子任务报告→Agent→孙任务→两级返回/焦点”路径走完全套原断言；无 sleeps 或预算放宽。

## SQLite 专用测试登记

W5 正式日志的唯一差额是已发布 `rfc371-report-snapshot-file-performance.test.ts: 1`；新消息字段回归还增加 `rfc371-native-message-field-reuse.test.ts: 1`。两份被测物分别是 SQLite 独有的 FILE TEMP/页缓存和 OpenCode 原生磁盘 SQLite/WAL 文件，原应用报告 staging/计数仍由双 provider 套件覆盖。只正向登记两处真实构造并具名说明，原机械分类、断言、扫描、open 库存及所有旧账本行/why/顺序保持。

并行会话独立负责两份原回归的纯 TypeScript 修复，其精确提交与原输出保持。此片只审功能；有限实现门、完整源码配套及新 exact-SHA hosted 结果分别核验。约22秒首次生成仍未解决，两个 RFC 保持开放。
