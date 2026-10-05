# RFC-370 原生材料目录生命周期匹配记录

本片仍在 A-T5。三个原生入口的生命周期已接 application port 和独立 local adapter；完整 selected 材料／取证／生命周期／执行／receipt 组合、真装配根、脚本、执行权恢复和 A-G 尚未完成。CS adapters、M0 首次部署和 M1～M4 尚未开始；没有 AW-in-CS 部署。

## 候选与匹配投影

SOURCE12-R1 独立有限功能 PASS：12 owned／7 control／11 evidence，指纹 44d8421b24d78f630c81fac7c51a0ca7b2c604bafa8aa7e007039b00d1886243。三份完整原入口算法和两个原 helper 的 AST 对拍、原 PWD 断言与预算、Windows 原字节逆映射保持；六个实际文件生命周期回归交正式 CI。

原 scoped census 只执行一次，语料为 committed 6015b11f38cbdac1adfac6ac633709e44462aa05 加冻结源码；非自有源码与四份规则读取原提交，排除且保留并行 RFC371 WIP。sourceDigest 为 sha256:a139a9620d7ce1f050e4f0eecbf7cc6ae19aa5b570d693c37fcead03b0476246。后继 dd4fefbbbf55cf8c8852631b003f8ec621aaa9e4 仅观测测试／文档，生产语料、规则、13项架构记录不变，因此沿用候选和一次 census，由原 provenance helper 刷新发布基线；没有因 HEAD 移动重跑。

三个实际 gateway value/export 和一个 native util import，连同两个原 consumer 边的 relocated owner 更新，产生 imports6357→6361、exceptions5642→5646。新两个文件根、两个正常 port type、private native input type 与 binding factory 使 owners26778→26784；两个原函数的迁移不产生净增长。129 条原有序库存、原字段和 why 保持，只有这三项实际增长具名一次许可，发布后以正常后继退役。

317 条原债的顺序、非投影字段、why／退役条件、原 findings 保持。原 helper 更新实际 canonical owner 链接，只新增一个 R1 value/export 分组：services/runtime/index.ts → runtime-management/infrastructure/local/agentMaterialWorkspace，318 条、inbound285／outbound33。native infrastructure → util/platformExec 是真实 observed 边，但不满足原 R2 application/domain/engine/public 与 legacy-prefix 判据，不能虚增 R2 债。该精确兼容组待 A-T7 真根收口退役。

原40 required SPI、69 target edges 与 implementation SCC 空集保持；原 classifier／counter／validator／renderer 未改。status.md 是原 raw renderer 字节，不额外格式化。旧 current-report 的 task-execution 文件数386落后于已提交388；本次原生成器给出388，另用原 moduleShapes 加 committed 文件集合确认所有 moduleContexts 与原总量1620一致，排除并行未提交文件，没有重复全 census。

SOURCE12 的 STATE 记录已由 dd4fefbbb 提交的共享全文保留；该会话只在开头追加自己的段落，冻结 STATE 仍是完整原文后缀。本片不重写、不重新暂存这份已经提交的共享文件。源码与其余候选字节保持，matching metadata 门另验收此文档与发布范围。

## CI 证据与开放项

430e0aba 主CI37274203313正式cancelled（50jobs：21success／4failure／25cancelled）；Windows37274203292正式failure。已保留 readonly fixture类型、原direct拒绝后drain行为、S15／RFC108源码定位修复；其新增S15未导入join的TS2304，由6015b11f一行改为已导入resolve修复，独立有限门PASS。6015主CI37275867646正式cancelled（50jobs：13success／2failure／35cancelled），失败仍为RFC371测试类型与required汇总；不会将取消或单项通过称为全仓绿。430 的原canonical mismatch即上段386／388记录差异，当前匹配投影补齐；后继全仓CI另验收。

没有本机 AW tests、typecheck、build、服务或全 gate；只做 owned 格式／lint、纯 AST／JSON／字节校验与原静态 census。独立有限门、精确提交／远端同步、正式新 exact-SHA CI 和部署分别留证；旧 FAIL／cancelled 证据不替换。本片不是 A-T5、A-G 或 RFC 完成判定。
