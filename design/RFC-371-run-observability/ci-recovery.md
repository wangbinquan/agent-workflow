# RFC-371 CI 与定时工作流修复记录

更新：2026-09-30。本页属于 AW-R01 的 CI 关闭证据；两 RFC 的产品剩余范围继续按 remaining-work.md 实施。用户本轮明确要求修复 AW CI 和定时 CI，因此本轮读取失败步骤与日志定位根因；此前仅记录扫描元数据的历史保留。

## 基线与根因

- 当前基线 `f3bfc548fb25edfa95994e262730186820148f03`。[提交 CI 36658830125](https://github.com/wangbinquan/agent-workflow/actions/runs/36658830125) 终态 failure，48 success/2 failure。失败源是 dependency audit gate 的两条 fast-uri high 公告，CI required 随之失败；其余功能检查通过。
- 根清单已有 fast-uri 3.1.6 覆盖；本轮改为 **3.1.7** 并以 Bun lockfile-only/ignore-scripts 生成锁文件。仅该覆盖值、包版本及其完整性摘要变化。官方 [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) 和 [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) 均列 3.1.7 为修复版本。本轮不增加公告豁免，不降低严重度或必需检查。
- 三类红色定时运行都在旧 `904ccfdaa0de41d63472d1a4c251a657a32857fa`：WebKit [36578655269](https://github.com/wangbinquan/agent-workflow/actions/runs/36578655269) 与 full E2E [36566313981](https://github.com/wangbinquan/agent-workflow/actions/runs/36566313981) 在 Node 加载 JSON 夹具时失败；空 route-hit artifact 与覆盖对账拒绝是前置失败的后果。Windows [36571611662](https://github.com/wangbinquan/agent-workflow/actions/runs/36571611662) 是三处 capture union matcher 的 TS2769。
- 上述 JSON filesystem 读取与 capture kind 显式收窄已经随 `8c6e9a0766a1a184170dec1e9685a07b580334e5` 合入，并已确认是当前 main 的祖先；本轮不重复改写或削弱测试。旧 SHA 的红色记录不伪改为绿，新版本的定时配置必须实际运行验证。

## 本轮必须核对的工作流

| 工作流 | 频率（UTC） | 本轮退出要求 |
| --- | --- | --- |
| maintenance-soak-nightly | 每日 05:00 | 原 full 模式、默认规模和资源预算通过 |
| e2e-full-nightly | 每日 06:00 | 四分片与 RFC-319 覆盖账本对账成功，route-hit 完整 |
| windows-platform | 每日 06:15 | Windows 实际表面、类型、构建等全部成功 |
| e2e-webkit-nightly | 每日 07:00 | 两平台各四分片全部成功 |
| integration-opencode | 每日 07:30 | 固定工作流默认协议集成成功 |
| git-protocols-e2e | 每日 08:00 | 既定 Git 协议矩阵全部成功 |
| evidence-soak-nightly | 每日 08:30 | 原默认证据规模与预算成功 |
| visual-regression-nightly | 每日 09:00 | 原视觉矩阵通过，不批量接受差异 |
| postgresql-evidence | 每周日 03:30 | weekly/all 默认矩阵成功，真实 PG 证据完整 |

九个工作流保留现有 schedule、workflow_dispatch、权限、测试强度与失败汇总。本轮将复用该候选自动触发的等价运行，仅对缺少等价运行的工作流从 main 手动触发，逐个记录实际 headSha、run ID 和终态；不在本机运行 AW 测试、构建、类型检查或服务。每周 PG 最近 [36309246936](https://github.com/wangbinquan/agent-workflow/actions/runs/36309246936) 在 `a53425b87bc6fa124d74829c278f52059ca04c93` 成功，仍需本轮新版本验证。

## 当前状态与关闭边界

版本与锁文件已修正，精确提交 CI 和九个定时配置的新版本结果待回执。主 CI required 与所有目标工作流终态成功前，AW-R01 保持未关闭；若发现新的真实失败继续定位和修复，不能将旧修正祖先或单个绿色分片当整体成功。并行 resource-catalog 四文件原样保留，不纳入本轮提交。AW-R02～12、CS 开发来源/清理/消费/两级明细及真实身份/模型验收继续，不以 CI 修复宣称两个 RFC 完成。


## 第二轮 CI 候选：传递依赖与启动回读（2026-09-30）

`ef28b3a14d3d4e536096df4fea4f9c6468104622` 的 [CI36665459531](https://github.com/wangbinquan/agent-workflow/actions/runs/36665459531) 终态 failure：47 success/3 failure。fast-uri 两条公告已消除；扫描又发现 brace-expansion 的两条高危公告分别影响锁住的1.1.18和5.0.9，已按官方 [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) 修复范围，在现有位置保持主版本升为1.1.20与5.0.11，仅两个版本/完整性摘要变化。npm注册表的dependencies与现有条目一致，frozen lockfile-only/ignore-scripts可解析；这只是锁文件核对，不是本机测试或CI通过。package.json没有新增直接依赖、豁免或跨主版本覆盖。

Ubuntu后端9/16分片的RFC185真实PG fan-out只调用两名成员，但任务最终ok。同一时间PG在host participant的post-insert nonce SELECT和assignment CAS上反复40001；十次事务预算耗尽会把尚未启动的卡片记为failed，领队允许这种终态聚合。夹具在runHostNode入口立即记录，没有等待采样问题。日志缺少派单ID和最后卡片错误，尚不能唯一还原漏掉成员的全部十次重试；不把相关性冒充唯一根因。

本批最小减冲突修正：在TaskExecution自身host participant用既有随机nonce生成器生成值，经既有mint overrides.envelopeNonce随行写入，成功后直接返回，去掉多余node_runs回读；公共mint类型、事务隔离、重试预算和失败收场规则不变。新增双provider真实并发三run、receipt与持久nonce一致、回滚后新尝试和实际SQL录制回归；旧三成员完整执行断言不变，只补卡片/run/系统错误诊断。新用例会确定性拦住这次不必要的回读，真实并发效果与完整三成员执行仍须新SHA hosted CI。

旧候选九个定时工作流均已终态。七个success：maintenance36665773019、Windows36665778557、OpenCode36665783652、Git36665786505、evidence36665789813、visual36665459576、weekly PG36665792231，均为上述完整SHA。full36665775717与WebKit36665780868为failure，诊断及增量候选见下节。本批改变依赖和启动代码，旧绿色不能直接关闭新候选；按新提交重新验证主CI及九个目标配置，不取消正在执行的定时矩阵。全部必要终态前AW-R01保持未完成。

CS原键持久停止源码bebb3d9b3b2a879a8e8ecf9b56b818fc912b15b7的精确CI36665601664六项success，2026-09-30T04:11:33Z本机八组件Ready=1、storage-contract=1、公开登录页HTTP200。它只完成停止底座；完整开发采集/owner清理/consumer/两级事实UI仍未关闭，生产开发采集OFF。两RFC继续，真实身份/模型验收没有执行。

## 第二轮定时诊断：真实价格访问与WebKit生命周期

[full E2E 36665775717](https://github.com/wangbinquan/agent-workflow/actions/runs/36665775717) 的四个Playwright分片全部success，失败在RFC319覆盖对账：新增的 `GET/POST /api/observability/pricing/runtimes/:registrationId/versions` 没有真实访问。本批在既有RFC371浏览器文件补 actual daemon CNY 定价旅程：保存价格版本201、读取历史200、刷新后同一持久版本/价格、零价与未定价分别显示，并核对运行时配置修订/模型未被价格保存修改。没有mock定价路由，不改uncovered账本或覆盖门禁。

[WebKit 36665780868](https://github.com/wangbinquan/agent-workflow/actions/runs/36665780868) 只有macOS 4/4分片失败，终态 **1 failed + 1 flaky**，不能只描述成重跑成功。RFC371趋势图首轮/重试均在键盘末柱焦点失败；macOS Safari默认Tab只遍历文本控件，已有 `e2e/ux-consistency.spec.ts` 使用原生Option+Tab。本批沿用同一平台/浏览器判据，所有柱仍通过真实按键依次到达，增加每一步焦点断言，宽窄屏末柱可视与截图断言保持；不程序化focus末柱绕过键盘路径。

WG-35人类owner在线点首轮计数0，重试success。该夹具默认真实session，owner来自同一 `/auth/me`；PresenceDot对确定离线也画点，因此0代表unknown而非未在线。首轮仅有视频/error-context，成功重试trace无WS帧，不能唯一确认此次CI的失水化原因。源码存在可以受控覆盖的时序缺陷：断线render的passive effect可在新open+snapshot后清空唯一快照。本批用共享socket可选同步生命周期回调在断线/新订阅尚未连接时reset，移除presence旧connected passive reset；权限失败关闭及认证代次守卫保留。新增真实hook/共享socket重连回归，在布局阶段交付新open、可选snapshot后再允许旧effect执行，分别验证最新已知值保留、无新快照仍unknown、迟到旧帧不覆盖、新连接断开回unknown。原WG-35全部断言保持，不加固定等待或更改重试/预算。

依赖/PG启动原八路径已独立静态功能复核PASS，定时增量随完整候选继续复核；这些测试未在本机执行，新SHA hosted主CI、真实full覆盖对账及两平台WebKit矩阵全部成功前，不声称已解决全部失败。

## 第二轮发布后：Windows必需字段补正

完整12路径候选已独立静态功能复核PASS，并以 `18c487f8c57743c9731b8757b31d9795d494004b` 精确推送，提交前后主分支与远端一致、四个并行resource-catalog路径未改动。[Windows 36671976956](https://github.com/wangbinquan/agent-workflow/actions/runs/36671976956) 终态failure：新 `rfc369-workgroup-mint-receipt.test.ts` 的任务夹具漏填必需 `startedAt`，TS2769在执行功能测试前拒绝。本批补 `startedAt: Date.now()`，不放宽类型，也不改变三个兄弟mint、实际持久nonce、SQL回读禁止或回滚重试断言。

主CI已结束的macOS后端6/6除两个夹具NOT NULL失败，还报两条canonical精确生成投影失败。沿用官方生成器，源码仅在内存读取已提交main与本任务候选，未建立其他checkout或改动并行来源。新增顶层onPresenceConnectionState符号导致归属分母25510→25511；同步13份生成/治理/状态产物、sourceDigest sha256:60f3075ecd59dc84e313b9a2c78ebb35c65aaa8ee6245e3848f40d6c23716dd9及四份内容寻址provenance。唯一allowGrowth按原规则精确解释这一个新增符号，下一笔无增长提交须退役；不增加架构违规、豁免或放宽生成相等检查。

同一SHA的主CI36671910180已终态46success/4failure：Lint+Typecheck、macOS后端6/6、Ubuntu后端8/16及required；日志逐项确认类型/NOT NULL时间遗漏与canonical投影是全部根因。九种定时配置八success，Windows类型失败；完整E2E36671974233的四分片和覆盖对账、WebKit36671979603的两平台各四分片均成功。原全部十个运行正常跑到终态，没有取消。新候选仍须实际执行全部原有矩阵，不修改schedule、重试、规模或预算。本机AW门禁未运行，AW-R01保持未完成。

第三轮18路径独立静态功能门PASS：首尾冻结hash匹配，2721份提交生产源码独立重算摘要匹配，四份治理内容摘要匹配，仅新增onPresenceConnectionState这一归属条目。原测试与严格投影/增长过期判据保持；没有本地AW测试或服务。发布前只更新旧矩阵完整终态回执，生产和13生成产物内容不变。
