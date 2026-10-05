# 同材料入口 CI 检查补正

2026-10-05。仍在 A-T5；完整 selected factory／真根、脚本、执行权／恢复、A-G 和 CS M0～M4 未完成。

精确 SHA `ab30bc10fafd26f76a075bd2b4a034ca9e4748e1` 的主 CI `37296573386` 已正式 completed／cancelled：48 个作业中 21 success、7 failure、20 cancelled。7 个 failure 包含最终汇总作业和 6 个后端分片，不能将已通过分片或包含源实现的 Windows 成功记成整体成功。失败日志和终态保留。

本批引入的两组失败按实际源码补正：

- `opencode-spawn-pwd-env.test.ts` 的 Task／System 用例仍查旧 native binding 的 environment 地址。Task 改查实际早期 `cmd/env` snapshot，System 改查同一 plan 的惰性 environment；两条链都继续查 native binding 向原 executor 传递 cwd/env。原 PWD 环境块、唯一 spawn、distill 委托、其余断言、用例和预算保持。
- `rfc294-review-offered-edge-dag.test.ts` 的实际 offered 边缺两条逐文件登记。四个 type imports 形成两个 from-file／to-context 组合，精确登记 RM application/local 两文件对 TE 的引用及其清偿条件。原 DAG、required-SPI 分类、算法、语料、相等／stale 和负 fixture 全部保持；不加入通配或改变目标边。129 项 ledger 库存、原 why 和其余数值保持，仅匹配此项 37→39 的真实增长并点名 RFC；匹配发布后以普通后继退役 consumed permit。

其他两个失败来源已由并行提交处理：`a0117acb4157f594f5528c9a7833e7362de653f0` 删除无消费者的 `NativeHistoryStep` public 导出，`059a845fcac4a5a169086eef293d2aa707a4204d` 更新与其实际生产源码匹配的 canonical 清单。保留并行完整输出，不重复生成或提交其源码。这批不改变生产代码，沿用当前已提交 canonical 内容。

本机只做 owned format／lint、纯 AST／字节／JSON 与原 provenance helper 投影，不运行 AW test／typecheck／build／service，不重跑不变的 production census。独立有限功能门、精确发布及新 exact-SHA hosted CI 分别留证；本说明不替代 CI、完整 A-G 或 AW-in-CS 部署验收。
