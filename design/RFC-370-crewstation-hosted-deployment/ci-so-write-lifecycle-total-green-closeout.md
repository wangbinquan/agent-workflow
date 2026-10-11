# SO write lifecycle：完整 CI 与前期代码验收

确切提交 `0d43da993b23d245f3f4fd154c55ef1798642d95` 的[主 CI 38147310877](https://github.com/wangbinquan/agent-workflow/actions/runs/38147310877)已正式 completed／success，72／72 作业成功，包含 CI required；同一提交自动 push 触发的[默认完整 Windows 38147310902](https://github.com/wangbinquan/agent-workflow/actions/runs/38147310902)正式 success，26 步全部成功，没有额外手动派发。根会话已核对全部 73 个实际作业的 run／head／status／conclusion，用户要求的总绿前置门已满足。

## 实际功能与类型检查

原 H／L／R／SO 登记人口及原 boot 源码身份保持，45 份后端或 Windows 原始日志和主类型作业日志共 46 份已完整 EOF 读取、解析并复核；未读取 Static scans 原始日志。两边四个工作区各有真实 typecheck code 0，共八条。

| 原合同                 | Ubuntu | macOS | Windows | 实际执行总数 |
| ---------------------- | -----: | ----: | ------: | -----------: |
| HumanGate              |     93 |    47 |      47 |          187 |
| Task runtime lifecycle |    105 |    53 |      53 |          211 |
| Task resource recovery |     33 |    17 |      17 |           67 |
| SO write lifecycle     |     51 |    26 |      26 |          103 |
| Original boot recovery |     23 |    23 |      23 |           69 |
| 合计                   |    305 |   166 |     166 |          637 |

以上为具名 hosted 实际执行数，目标案例无缺失、额外、重复、fail、skip 或 todo。根已逐条读取 471 次 Ubuntu／macOS 与 166 次 Windows 的名称、上下文、状态及耗时；最终独立重解析的全部 637 行与已消费行精确一致。五份真正发布源码的完整字节／SHA256也与原人口逐项相符。该验收保留 SOURCE R1 FAIL、R2／MATCHING PASS、唯一原 scoped census、全部旧预算和并行输出，没有本机 AW tests／typecheck／build／service／E2E 或额外 census。

## CI 修复事实与边界

PostgreSQL 镜像获取与显式 start／probe／cleanup 已发布，W8 原 services-only 判据已适配实际接线；原案例、provider scanner 和两平台例外保持，新负例覆盖不完整接线及 YAML step shape。63446f12 的主 CI 失败、旧原生预算失败与所有门历史保留。

9c792382 的主 CI 72／72 成功而默认完整 Windows 因真实 custom observer 程序 timeout／1 失败。本次仅向原 Node 夹具增加两条 stderr 进度诊断，完整原测试／脚本 inverse、独立设计与实现 PASS 已消费。0d43da993 的同一真实 Windows 用例实际 pass／2629.40ms，原 10000ms 程序预算和 50000ms 用例预算保持。此次通过不建立此前超时的根因，不把诊断称为生产超时修复；标记也不能单独证明进程已 exit／flush／reap。详见[诊断设计](ci-custom-observer-native-timeout-diagnostics.md)和[W8 接线](ci-postgres-wiring-oracle.md)。

## 完整证据与后续

根消费证据为 `/tmp/aw-rfc370-ci-native-observer-diagnostics-ci-0d43da993-root-total-green-consumed-r1.json`，4310 bytes，SHA256 `fe94095eda0ca61babe38b97ebd2520e4f796e824d8e3f71ba7d8e74a5b77c92`；原完整总绿 verdict 为 36673 bytes／`2b65e32aea52280595a9d0720d5ef217ea8f011e187b4bc14bb6b81ca3405967`，实际案例 verdict 为 358586 bytes／`6ac1bfdef7b8dc045a0f5e272cda4036b3c90cd9bd51dd109b8c157cbb7cd146`。独立全日志重解析证据为 396625 bytes／`9ec01757b1088f3188f546c2dcfa1c05696bf5527a3479a3d905501154ca4826`。上述原始证据只读保留，不覆盖旧失败或原生成历史。

继续[Task provider 完整装配](task-provider-host-assembly.md)的独立设计，再接实际三个根与十九 owner。完整 H7／A-T7／A-G、各层独立 CS adapter、先 M0 首次部署再 M1～M4 仍待完成；AW 尚未部署 CS，RFC 未完成。累计用量持久化由「设计运行观测统计全景」会话负责。
