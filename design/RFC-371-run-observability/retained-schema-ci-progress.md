# RFC-371 retained schema CI 修复记录

本片处理 `1820be8c2e59daedaeb076eda76f44403e673eff` 的正式 CI 兼容失败。主 CI `37417648524` 已 completed/failure，原终态保留，不以有限审查或历史绿色替代新提交的完整 CI。

## 修复内容

平台原生 retained revision 通过一个完整逻辑合同操作同时返回 SQLite 与 PostgreSQL 语句；两个投影为私有实现，验证 descriptor 的位置唯一。没有 descriptor 的历史合同返回两份空结果，非法或重复 descriptor 继续失败。原 SQL、种类、逻辑身份和排序保持。

纯构造对比了全部 18 个历史版本。原 contractDigest、planDigest、完整计划摘要、SQLite 12 条原语句以及当前 PostgreSQL 的 3 个函数和 12 个触发器均与修复前相同。没有执行数据库或本机测试，没有修改已发布 migration、历史合同或原 guard。

配套断言按实际当前 source 222、active 216、archive 6、journal 241 更新，原历史冻结值保持。PostgreSQL 的全库 retained 触发器与 node_runs 触发器分别验证；controlled upgrade fixture 只接受已验证历史里的确切原生 SQL，增加首个 function／trigger 故障时整笔 DDL 与元数据 rollback 的回归。旧质量索引 fixture 在实际 building 父状态下构造缺口，再恢复原终态，并继续验证终态篡改被 seal 拒绝。原人口、断言和时间预算保持。

SOURCE15-R1 有效 FAIL 的唯一 P2 是 SQL 返回 PromiseLike 却直接调用 catch。R3 使用 Promise.resolve 同化后清理，独立有限 PASS；原 FAIL 和一次 preparation assertion 失败都保留，后者不算审查通过。该修正只有一行测试 cleanup，生产内容及原 census 输入的生产人口保持。

## 匹配登记与验收界限

使用完整已提交 `2f3807d003c396b344ceddcb0c2278fe86ee90e0` 与冻结候选完成一次原 scoped census。初次漏传 write 的 report-only 输出不算完整生成；其后 write-mode 的完整原生成留证，没有修改 scanner、classifier、counter 或 validator。sourceDigest 为 `sha256:261ca20a23bc3706ff827dbfca2425bc3b6c3c46c8a0a5e72218571d216393da`。

13 份匹配登记保留 129 项原有序库存及 why、345 authored debts、214 guards、40 SPI／69 targets、原 SCC 与 Task effects。只登记新完整平台操作带来的 owners `27086 → 27087`，按原规则退役前批六项已消费增长许可；不是统计能力或预算放宽。status 保持原 renderer 的完整字节等式。并行 RFC-370 未提交 MCP／Runtime 改动排除并保留；共享 STATE 的旧全文也完整保留。

本机仅执行定向 format／lint、纯 schema／字节／AST 构造与上述一次原静态生成。AW tests／typecheck／build／压测不在本机运行，正式结果交发布后的确切 SHA GitHub CI。原 root/refreshed-link 的 5000ms timeout 尚未证明根因，未改预算或用重跑掩盖。

用户已授权原数据库与原 7456 端口启动复现。本机实际日志显示原库版本 241 与 listening；共享文件热更新曾退出的错误日志保留。正常 bun dev 当前使用共享 WIP，不能称干净提交部署，不能把并行启动装配记作本片贡献。已查看的实际总览为 8 任务，123238 Token = 输入 96095／缓存读取 21120／缓存写入 0／输出 6023，已记录人民币估值 ¥0.16583，存在缺口的记录继续明确标记。

默认 producer OFF、CS v2 数值消费者／before-final／seal、真实 CLI／算力自测、CS 托管实际联动、原 full-report／self-total 规模资格与两个 RFC 的退出条件仍开放。CS 原双规模 240 分钟 timeout 不算通过；后续批量 TEMP 读取使用独立设计与实现门，不混入本片冻结候选。
