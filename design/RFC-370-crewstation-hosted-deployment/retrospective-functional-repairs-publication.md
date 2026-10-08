# RFC-370 既有功能问题修复的发布配套

用户要求先回顾此前实现的正确性和质量、修绿 CI，再推进适配能力。本片收口原回顾确认的 H345-P2-001 与 H7-P2-001，相关设计、源码、测试、配套和 hosted CI 分别验收；未完成的 H7、A-G 和 CS 部署不被本片签收。

## 已审查源码

COMPLETE DESIGN46-R2 与 SOURCE51-R1 均为独立有效稳定有限 PASS，root 实际消费首末完整 EOF 正文和三包装，SOURCE 指纹 `dc10aadbcd2ba96b650e582fc6c0f8f3a6f60bea54d17374b3b03bad5e4bedb8`。原 H345、H7 有效 FAIL 与私有设计修正历史保持。

11 个 production 文件、3 套原测试、2 套新增测试与 Windows 登记已应用，共 17 个代码文件；另有完整回顾修复文档，组成 SOURCE18 owned。精确原 owner、方法、receiver 和 retainedRef 跨原 await 保存，在原终端阶段仅退役逻辑引用；实际 Intent、Memory、Narrative 和已打开 invocation 的无结果拒绝分支覆盖完整链路。common 捕获一次 ref，实际 core、legacy 和 prepared 三个调用者完整输入保留。原目录保留、原错误、物理 release、slot 与 ACK 语义保持。H7 failure 用记录的存在性保存原始拒绝值，包含 `undefined`，在原 adopt／close 边界清空。

两 provider 与实际 native-owner 回归随源码交 hosted CI；原 case、断言和预算保持，Windows 只加四处路径过滤和两个套件入口。没有本机 AW tests、typecheck、build、services 或 E2E。

## 唯一原生成与完整库存

原 scoped census 固定已发布 `d05fc28b026bd01e45662cb1d282664de4638182`，只叠加已审 11 个 production 和 5 个测试，其余 6724 个源码路径读取该提交完整 blob。四个原规则保持，13 个原始输出先私有保存，没有新的 classifier、完整 census 重跑或源码投影。sourceDigest `sha256:67b6d66cc0ff1163f62e52dd533d13fa2377e55f47a836d2c7d2f395e258f9bc`，3207 个实际 production／原额外文件的完整字节哈希输入独立复算一致。

完整经典边界数组前后相等，本批原范围 inbound 6／outbound 5。原 owner、写入、事务、后台、import／exception、facade、target／SPI／SCC 全部业务 payload 与数组保持；完整 report 只更新源码摘要。两个既有 public 合同加入真实 `forget` 方法和输入／返回字段，1238 个有序入口完整保留，另外 1236 行不变；原已有方法及 field 类型保留，只更新原生成派生 consumer 集合和实际方法／字段计数。SystemAgentRetainedContents 方法 1→2、字段 10→12，SystemAgentRunFamily 方法 13→14、字段 144→146；原 classifier 派生的既有 family 测量值随真实合同同步。

原 governance 全部 authored 内容与历史 findings 保持，只更新原源码投影和 provenance；guard 清单只作完整不透明字节／payload 保留，不做其它检视。129 个有序 ledger 行、why、baseline 与所有字段逐字业务相等，实测人口没有增长，`allowGrowth` 为零，无须一次许可或退役提交。RFC-294 status 仅替换原 sourceDigest 行。

首轮私有清单证明将原生成对象的键枚举顺序与排序路径数组直接比较，实际失败原件保留；R2 只改成同一 13 路径集合比较，完整原生成和输出不重跑、不改写。配套正文与 shared STATE／plan 保留完整旧前缀／后缀及并行输出。

## 发布与远端验收

独立 matching 门、精确源码／配套提交、远端 0／0 与新 exact-SHA CI 尚待分别验收。前批 `d05fc28b` 的主 CI 37711897500 与 Windows 37711897530 已启动，其正式终态另外留证，不能用静态 PASS 代签。

本片完成后继续原 Task runtime lease、Node 写入／恢复、19 capability owners、三个执行 roots、A-T7／A-G，再编写各层独立 CS adapters。M0 先首次实际部署，再逐步 M1～M4。AW 尚未部署到 CS，RFC 仍为 Stage A／In Progress；新适配实现继续暂停至回顾修复和 CI 收口。
