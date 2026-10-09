# RFC-371 已确认零消耗的原批次验收

## 原始执行与完整人口

2026-10-09 使用原许可的本机验收身份、原 AW 服务和原数据核对，没有再次运行模型、修改全局默认算力或补写 Token。原 8 个工作流任务的模型执行失败，关联 16 组自动记忆提取；不能记为 16 个内置 Agent 或 Git 成功验收。

原报告 `496b788e-4dee-42dc-b4a9-bdd26e654da4` 保持不变。同一批数据的新报告 `2c77d610-e1f6-4e6d-bf2a-e4762efb82ec` 仍为 `not-ready`，具有可查询事实；Task、System owner、原生 capture 与 SDK 的实际记录分别核对。

| 原事实                        | 完整数量 |
| ----------------------------- | -------: |
| 任务及关联记忆组              |       24 |
| 调用                          |      112 |
| 尝试及原历史引用              |      136 |
| 有完整空 capture 的工作流调用 |       64 |
| 没有 capture 的记忆调用       |       48 |

10 类原集合分别为 agents 11、attempts 136、historical-executions 136、invocations 112、purposes 2、quality 5、runtimes 2、sources 1、tasks 24、trends 1。所有集合读取到 EOF，共 31 个实际传输页；17 仅是传输页大小，不限制统计人口。新旧每一行的全部非指标字段一致，全部原 ID 与原持久事实一致。新增零值证明的 12 处汇总范围逐项核对。

64 个原 SDK 根及其递归子会话读取到 EOF，确有零个 step-finish；48 个记忆调用没有 capture，仍未知。不能将未知调用写成零，也不能由失败状态推断消耗。

## 四桶与人民币

新汇总显示非缓存输入 0、缓存读取 0、缓存写入 0、输出 0、合计 0；`knownZeroInvocations = 64`，已观测调用仍为 `64 / 112`。原历史引用 64、已观测历史引用 0、records 0、四桶记录数 0 全部保持。

原可见且已确认的零费用调用为 64，新 `recordedCost.amount = "0"`、currency 为 CNY；原 pricedRecords 仍为 0。这是已确认部分的 `¥0`，不是完整估值。没有平台估值证明、隐藏费用或仅有 Token 零证明的调用不能据此得到人民币零值。`native-capture-unobserved`、`usage-unobserved`、`invocation-unobserved`、`historical-invocation-unobserved`、`historical-native-unobserved` 五项原缺口全部保留。

## 正式页面

许可的 dev-admin 仅查看本机正式页面，筛选原批次名称与原时间区间。总览显示 24 个任务、112 次运行时执行、已记录 Token 0、四桶 0、记录不完整 64 / 112 次调用及 `¥0`。人民币说明为“已确认零费用调用 64 · 不代表完整估值”。趋势显示“24 个任务 / 已记录 0 Token”及四桶零值，没有以灰条或正值柱虚构消耗。

中文实际页面分别查看 1440、768、390 宽度。768 的两列卡片水平间隔为 16px，换行间隔也是 16px；documentWidth 与 viewportWidth 同为 768。390 的 Token／人民币卡片及短说明可读，documentWidth 为 390，没有整页横向溢出。数据质量表使用自身滚动区，原缺口保持。

1440 英文页面实际显示四桶、`¥0` 及 `64 calls with confirmed zero cost · Incomplete estimate`；三列卡片间距为 16px，documentWidth 为 1440。已恢复中文，保留原筛选和时间口径。没有修改全局主题或默认运行时；这项页面核对不代签所有主题及所有 RFC 页面状态。

## 可复核证据与剩余工作

本机私有证据目录为 `/private/tmp/observability-aw-all-task-type-validation-20261008-v1`，认证内容不入仓。原 API EOF 文件 `approved-original-known-zero-eof-v156-all-sections.json` 的 SHA-256 为 `3f69b8b4a1c277abcc9d51cfc0e876ece0b4a429ab0a3ad2c16ddf8dfea0cd28`；原 SDK／持久事实对账 `approved-original-known-zero-native-oracle-v157.json` 为 `ef9866a88944d101ae8867738d8ff97a88c4be8dc9cd0673d8a2c92a84b7d047`，结果为 `PASS-ORIGINAL-KNOWN-ZERO-COHORT-SDK-AND-ALL-UNKNOWN-QUALIFIERS`。

原计数脚本 v148 只选业务 Task、v149 错误地要求全部调用未知的失败均保留，修正不会把原失败写成成功。本次不代签 Git、数字员工及原模型成功执行。定时任务的原成功验收已具有四桶 `14015 / 19072 / 0 / 502`、合计 `33589` 和验收人民币估值 `¥0.041582`，需要本片后继正式页面／新报告回归；不再次执行模型凑结果。

源设计门、实现门及变更文件静态检查已通过；本批架构配套门、精确上库及 hosted exact-SHA CI分别验收。默认算力临时切换仍等待人类答复，CS 原失败门豁免仍未取得；CS 新发布部署不能据此启动。两个 RFC 的全类型成功执行、平台生产采集、完整跨度和规模等退出项保持开放。

## 2026-10-09 发布后正值回归

本片已随 `83c6b76f545fc26e314a0e98dd23ff1025d81eef` 发布，其主 CI 的 72 项作业和视觉回归的 1 项作业均 success，详见[发布回执](./known-zero-metrics-publication.md)。上节提出的原定时任务后继回归已完成：新报告 `d7d503e8-467a-4169-ba15-ff83313e4586` ready，13 个根集合及维度成员共 28 页到 EOF，3 个原生会话、4 个唯一步骤、四桶 14015/19072/0/502、33589 总量与原冻结 ¥0.041582 保持。正式分类柱、各明细与时间口径往返已查看，没有重跑模型。

随后用户批准的记忆专用运行时租期完成一个原 `task-run` 作业，实际 13335 Token、¥0.037662；临时配置已恢复。该新报告保留原三次未知调用及新一次已知调用，正式页面在不完整状态仍显示分类数值与人民币金额，未改写本文原 112 次调用的旧封存报告，见[原作业与配置恢复](./memory-distill-real-validation-20261009.md)。这项正值回归与零值证明各自独立，不把重叠报告相加为新的系统用量。
