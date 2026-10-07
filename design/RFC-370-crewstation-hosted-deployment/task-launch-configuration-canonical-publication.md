# RFC-370 Task 配置接线与配套清单发布

状态：源码 SOURCE19-R3 已有效稳定有限 PASS；配套清单有限门、精确提交、远端同步和 hosted CI 分别验收。仍在阶段 A，H7、A-T7/A-G、各层独立 CS adapters 与 M0～M4 仍开放，AW 尚未部署到 CS。

## 源码行为

16 个生产文件将所选 Task 配置查询接到 CLI、SQLite HTTP、PostgreSQL 的原启动、继续、retry、仓库准备与 Fusion 入口。默认 native 同步读取时点和政策保持；显式 App file 或 storage binding 总是使用自己的同一查询，不读取根默认文件作为替代。CLI 两个 provider 会话沿用 bootstrap 的同一 Task binding。

selected 启动等待四次读取，清除 18 项旧 runtime 默认值后投影当次值；继续驱动保留原读取顺序。原 workspace cleanup、intent/admission、业务事务、明确 command override、short coordinator 与 SC clone 效果顺序保持。新增回归走实际两种 provider HTTP/driver 和工作组 continuation、held ACK 与 cleanup，不用零消费者 facade 代替入口接线。

SOURCE19-R1 的两个 P2、R2 新回归误写 close 的 P2 均完整留证；R3 只把真实 fixture 清理接口改为 dispose，原 18 份其它源码和全部旧 control/evidence 字节不变。最终有效稳定回执为 390567 bytes，SHA256 30c75333d0a9ccc9fef9b424043300ece7d01a6211ad8f2532c5dbc17b488f07；root 全部 91 项与三个 wrappers 真实 EOF 绑定，FP 78049d1535ff185d0022a8e855198b99d7636b4a1d57d1c750b38a1f18416f5a。

四份相关共享 bootstrap 文件保留完整并行 RFC-371 Native 接线。本次提交描述同时记录这些并行内容，其已发布的独立依赖保持；不剥离其它会话的 hunks。H7 及其它 tracked/untracked WIP 不纳入本批提交或静态输入。

## 原静态生成与配套

一次原 scoped 生成使用固定 fcb05baef62ddfe16fc2fe572a85b3c1e6cd6543 加本批 16 个生产和两个回归文件，四份原 generator/rules 字节保持，私有生成 13 个完整原产物。sourceDigest 为 sha256:ce77a1bc533f324c116be9765456bfcd93e13d4ebe4ee870564e5cd4121c7bca。classic 原完整 inbound/outbound 数组逐项相等，仍为 50/0；不是借 canonical 角色反推规则结果。

原完整 import/exception/owner 行及其顺序保持，真实新增 7 条 import、5 条 exception、2 个 owner 和 1 个 public export。六个既有 public 的派生消费/方法/字段投影随冻结源码更新；36 个 physical call-line 锚点依原算法移动，原后台与 Task authority/effect 政策字段保持。首次私有准备错误（把 source-derived timer symbol 也误当固定 id）保留；修正纯投影比较，不重跑 census。

129 个原 ledger 的顺序、why 与其它字段保持，仅四个本批实测 baseline 与对应 one-commit 说明更新：imports 6782→6789，exceptions 5956→5961，public 1217→1218，owners 27387→27389。按原 helper 重算 ledger digest；发布消费后普通后继退役，不删原库存，不放宽原谓词或预算，不改其它 SPI/target/guard/分类。其余完整 opaque payload 和 status 的原生成结果保持。

## 验收边界

本机仅 scoped 格式/lint、纯 AST/字节/JSON 和这一次原静态生成；没有 AW tests/typecheck/build/service。有限源码 PASS 不代表正式 CI 已绿，也不覆盖新 H7 停止派发在制品、完整启动前恢复/19 handles/Task 事务上下文或 CS 部署。提交后分别记录实际 SHA 与原 hosted workflow 终态，旧 failure/cancelled 不替换。

补充格式范围：首次把生成的 status.md 纳入 Prettier 检查产生 warning，原输出和失败日志保留。rfc294-review-status-projection.test.ts 要求它与原 renderer 逐字相等，当前正式 format:check 也不包含 design 目录；因此保留原 status 字节，实际 scoped 格式 PASS 单列于十二份原 JSON、新文档和新增 note，不把原输出改成 formatter 的另一套表格。该边界不更改任何 CI 规则或已有逐字断言。

## 2026-10-07 RFC-370 Task 配置接线发布与四项一次声明退役

Task 源码及配套完整35路径已发布53be4913a91aad4385cdf52ee4c195abc0ba0e11，main/origin同步0/0、index空；四份共享bootstrap包含完整并行RFC-371 Native接线，其余H7/RFC-371在制字节保持。SOURCE19-R3和MATCHING16-R3已独立有限PASS，根会话实际完整消费首末所有源/匹配条目和wrappers。新SHA主CI37569551999、Windows37569551998及两项专项已排队，终态另验；不据有限门声称CI绿。

本普通后继只退役已随53be4913消费的四个one-commit增长声明。完整129行baseline、顺序、why及其它字段保留，仅按原payload算法刷新ledger digest。源码和13原产物不重生，三份共享文档完整旧前缀保持，仅追加本段；没有新census或本机AW执行门。

旧H7核心后继79d31c96主CI37557367648已terminal failure，72作业55success/17failure；已发布Purpose类型/receiver修复覆盖其对应错误，剩余功能源码reader/公共入口等按实际日志继续处理，旧失败保留。H7 binding及Task失权quiesce有限SOURCE7-R1已PASS，但实际三根、Task事务、19handles和named admission/A-T7/A-G继续；随后独立CS adapters，先M0实际部署再M1～M4。AW尚未部署到CS，RFC未完成。
