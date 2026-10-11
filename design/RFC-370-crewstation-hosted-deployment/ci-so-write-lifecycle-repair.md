# SO write lifecycle：确切提交的 CI 修复

状态：2026-10-11 修复候选，独立功能门及新 SHA 完整主 CI／默认 Windows 尚待验收。SO SOURCE R2／MATCHING 的有限结论与原回执保留；本片不签完整 H7／三个根／十九 owner／A-T7／A-G，AW 尚未部署 CS，RFC 未完成。

确切 `213453738c0c193d0469e360c409fb2d816fed7a` 的默认 Windows `38122091969` 已正式 failure：`Typecheck` 的 backend tsc 在约 4 GiB V8 堆上限报 `JavaScript heap out of memory`／code 134。原完整功能 suite 步骤成功。主 `38122091955` 已正式 completed／failure，72 个作业为 67 success／5 failure；类型检查作业 `114418748739` 报新夹具 232、261 行的 `TS2769`，macOS shard 3 作业 `114418749061` 与 Ubuntu shard 27 作业 `114418749194` 均报原 public consumer 清单缺少新增的两个公共类型。原 `Static scans` 作业 `114418748738` 成功，未读取其 raw 日志。

本片仅修三个已定位问题：

- 两个 fixture 回调先对缺失 `activeContext` 明确抛错，随后保留原 `expect(context).toBe(activeContext)`。原诊断的第 30 列精确指向断言实参 `activeContext`，这里在该断言之前收窄实际值。真实捕获、事务与 receipt 断言、全部 W01～W26 callback／注册／默认预算保持；不以非空断言或类型强转掩盖缺失上下文。
- 原 `UNCONSUMED_PUBLIC_SYMBOL_DEBT` 按原 W9-D 清偿波次追加 `HostExecutionWriteLeaseFacts` 和 `HostExecutionWriteLifecycle` 两行。原库存、原因、相等判据、负 fixture 和测试预算保持；两个类型的真实 production root 消费仍开放。
- 仅 Windows 的原 `Typecheck` 步骤设置 `NODE_OPTIONS=--max-old-space-size=6144`，继续运行原完整 `bun run typecheck`。不更改命令、检查文件、失败政策、步骤顺序或测试预算。当前仓库为 public；GitHub 官方 runner 参考列明 public 的 Windows 标准 runner 为 16 GB RAM，6 GiB old-space 留出其余进程空间。Node 官方 CLI 将该参数定义为 V8 old-space 上限；实际是否通过仍以新 hosted 输出为准。

官方资料：`docs.github.com/en/actions/reference/runners/github-hosted-runners`（public Windows 表，2026-10-11 核对），`nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib`。外部规格只用于选择 CI 进程内存，不能代替实际执行。

独立修复 R1 门正式 FAIL／一项 F01：首轮检查了断言后的另一个变量 `context`，未消除上述诊断。原候选和回执保留；R2 只改为断言前检查实际 `activeContext`，完整保留原身份断言，并另冻包复核。

原 macOS shard 1 作业 `114418749078` 另有三个未修改案例分别在 5 秒／5 秒／60 秒原预算下超时，并出现超时后清理引发的 ENOENT。先保留原源码、断言与预算，在本片的新完整 CI 上核对；不能把它们归为已修复，必要时按实际错误继续排障。

仅运行本片限定格式／lint和自写的纯字节／JSON／AST 保持核对；不运行本机 AW tests／typecheck／build／service／E2E。生产源码与全部十三份 canonical／projection／status 保持，不重跑 census。独立功能门后精确发布本片四条路径，重新等待确切新 SHA 的主流水线全部作业、默认完整 Windows 全部步骤、八条实际 typecheck code 0，以及 SO 103／原 H-L-R 465／原 boot 69 的共 637 次实际具名目标案例。总绿前置满足后再继续 provider／真实根实现。
