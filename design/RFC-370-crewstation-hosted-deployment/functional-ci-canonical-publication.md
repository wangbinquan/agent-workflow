# RFC-370 功能 CI 公开入口与完整根配套发布

本候选对应 SOURCE16-R2 的 16 条源码、回归和文档路径。SOURCE16-R1 有效稳定 FAIL 的唯一旧 materializer 地址 P2 已精确修正，原失败完整保留；R2 独立有限功能门通过，根会话已实际消费 65 项及三个 wrapper 的首末全文。有限门不代表新 SHA 的正式 CI 通过，不关闭完整 H7、A-G、CS adapter 或部署。

原唯一 scoped census 固定 `25da3dd426215aeb6873c19d575f1ec413e9f5fd`，叠加本批七条生产路径（六个现存文件和一个删除地址）及八条测试/数据路径；所有 H7 和未发布 RFC-371 WIP 排除。四份原生成规则不变，13 份输出的 sourceDigest 为 `sha256:999f5b299f78863f1ab21c416f1969ea0047deaae920f14c2628da8d7308c779`。只有原静态生成一次，没有 AW 本机 tests、typecheck、build、service 或 E2E。

## 完整原数据与实测差量

- 原 observed imports 全部完整保留并保持顺序，仅新增 SO authority port 对平台 `DatabaseProvider` 的类型边，6790→6791；原 exact exceptions 全部完整保留，仅新增其对应原分类行，5961→5962。分类、why、target DAG、required ports 和 SCC 仍使用原规则。
- evidence staging 的 `$file`、`assertEvidenceStagingFactory`、`assertEvidenceStagingLease` 三条 owner 从非标准 public 文件原样移到 application，只有物理 path/id 及两项 layer 改为实际位置；总 owner 数 27390 保持，其余全数组和顺序保持。两个完整函数、exact participants 的原名字与运行时不变。
- 公共合同与后台、ambient wiring、mutation、effect、facade、guard、SPI、commons 等完整 payload 不变，只按原生成刷新来源元数据。status 使用原 renderer 的完整生成字节。
- 原 129 条 ledger 的 id、顺序、file、symbol、why 与其它库存字段保持。两项实际新增 baseline 由本匹配的两条 one-commit 声明消费，普通后继退役，不再执行 census。经典边界的完整 before/after 数组相等，均为 inbound 0 / outbound 0。

## 前继已消费声明

前继 `25da3dd4` 已正常发布的三条临时声明，本批按其原 one-commit 协议退役；原内容完整保留如下。本批新增的两条声明使用独立的实际计数和当前来源，不沿用前继计数。全部未发布并行源码保持。

`rfc294-cross-context-observed-imports`，baseline 6790：

RFC-371 capability repair: one exact public capability query consumed by Task native invocation composition; original canonical count 6789 -> 6790. Measured committed dce3d3c6cbf686eab1fa5f682ee0be0b70da8f7c plus frozen own capability repair5 only; rules, original inventory, why and complete population unchanged. One-time growth only; retire on the next no-growth commit.

`rfc294-public-surfaces`，baseline 1219：

RFC-371 capability repair: one driver-owned native capture eligibility query; original canonical count 1218 -> 1219. Measured committed dce3d3c6cbf686eab1fa5f682ee0be0b70da8f7c plus frozen own capability repair5 only; rules, original inventory, why and complete population unchanged. One-time growth only; retire on the next no-growth commit.

`rfc294-module-symbol-owners`，baseline 27390：

RFC-371 capability repair: one new driver-owned eligibility function; original canonical count 27389 -> 27390. Measured committed dce3d3c6cbf686eab1fa5f682ee0be0b70da8f7c plus frozen own capability repair5 only; rules, original inventory, why and complete population unchanged. One-time growth only; retire on the next no-growth commit.

## 判据与范围

W29 与 MCP 原完整函数摘要、语句数、运行用例和预算保持。新增精确 inverse 只逆变换已审 Task 配置与并行 Native 根语句，所有其它语句仍归原完整根判据。两个 evidence 读者验证实际完整 Purpose 对象；materializer 仍要求 exactly one 直接 await。三个既有 DA→Integration type 边如实登记，清偿仍归 A-T7。

首个私有 JSON projection 比较遗漏了原 provenance 的 `currentSnapshotSha` 更新，错误日志保留；修正只允许该值等于固定生成 base，原其它 provenance 字段保持，复用同一次完整原生成。独立配套门、精确路径提交/推送、远端同步和新 exact-SHA hosted CI 分别验收。

Stage A 继续完成 H7 三根、Task 原事务、早期恢复、十九 handles、named admission 与 UI；A-G 通过后编写各层独立 CS adapters，先 M0 实际部署，再 M1–M4 逐项接管。AW 尚未部署到 CS，RFC 继续 In Progress。
