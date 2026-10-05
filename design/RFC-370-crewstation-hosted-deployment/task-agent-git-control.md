# A-T4／A-T5：Task Agent 的 Git control purpose 切面

本增量沿用已批准的 [选中工厂与实际入口设计](./agent-invocation-factory.md)，只抽取原 Task Agent 在进程前后读取 Git control 状态的效果。原 `gitMutationPolicy: 'read-only'` 业务规则、六份状态、结果分类及触发时机不变。它是完整 Task 入口重构的前置增量，不关闭 A-T5、A-G 或部署里程碑。

## 1. 原行为和归属

当前唯一实现位于 `packages/backend/src/services/runner.ts`：`captureGitControlSnapshot` 并行读取以下六条原命令，每个事实都保留 exitCode、stdout、stderr；摘要为原 `sha256Hex(exitCode + NUL + stdout + NUL + stderr)`。

| 字段           | 原命令                                           |
| -------------- | ------------------------------------------------ |
| head           | `rev-parse --verify HEAD`                        |
| symbolicHead   | `symbolic-ref --quiet HEAD`                      |
| index          | `ls-files --stage -z`                            |
| refs           | `for-each-ref --format=%(refname) %(objectname)` |
| localConfig    | `config --local --null --list`                   |
| worktreeConfig | `config --worktree --null --list`                |

refs 的 stdout 继续按原 `split('\n')`、排除 `line.startsWith('refs/agent-workflow/')`、`join('\n')` 投影，再同原 exitCode／stderr 摘要。不能改成读取 `.git/index` 文件、只保留成功命令，或用 HEAD 代替六字段。非零退出码、空输出和 stderr 都是原观测事实，不能丢弃。

source-control 拥有工作区与 Git 效果，因此完整 snapshot 合同和读取算法进入其 application；Task 继续拥有是否检查、字段比较、原失败状态和日志。完整声明的字段顺序、成员类型与 readonly 保持，Task 的 `changedGitControlFields` 正文保持。

## 2. 合同和实现

- `source-control/application/ports/agentWorkspaceGitControl.ts` 定义完整六字段 `AgentWorkspaceGitControlSnapshot` 与单一 `AgentWorkspaceGitControlObservation.capture()` purpose 合同。外部调用不传 cwd 或任意 Git argv。
- `source-control/application/agentWorkspaceGitControl.ts` 保留原摘要／私有 ref 投影与六命令算法，通过已绑定的 SC `RepositoryGitWorkspaceScope.run` 消费选中实现。应用层不读取文件、不选择 native 或 CS。
- 显式 native composition／`infrastructure/local` 绑定原 `runGit` 与一个惰性工作目录 reader，构成真实 local 实现；每次 capture 只读取一次当前工作目录，并保留原并行六调用及原错误传播。
- exact public participants 只提供已有真实跨模块消费者需要的类型。正常 Task 共同核心随后必须接收已选定的 observation participant；本片不新增可选正常字段或按缺失字段回落本机。

legacy `runNode` 暂时仍是显式 native 入口，它绑定该真实 local participant，并在原两个位置调用 `capture()`。构造是无 IO 的，不能提前读取工作目录或 Git 状态。前置读取仍只在原 read-only 分支，后置读取仍只在已有前置快照且进程不是 unreaped 时。正常 Task 入口、其余 workspace／材料／内容、所有根将在后续同一批准范围内接线，不用这个增量冒称选中根已完成。

## 3. 验收与发布

逆向对拍完整六字段、三个原 helper 的算法、六个 argv、NUL 摘要、完整私有 ref 谓词与原 before／after 分支；只允许读取效果的 receiver 跟随移位。保留全部既有 Task 行为用例、所有原断言和预算。补真实 local Git 用例，验证 public ref／index／配置变化与私有 ref／纯 index stat 刷新的区别，以及未出生 HEAD 的原失败事实；补惰性 reader 与选中非本机 participant 的功能用例，正式执行只交 hosted CI。

发布仅包括这一 purpose 增量和其原 matching 登记。源码、匹配元数据与确切 SHA CI 分别验收，复用未变候选的门；完整保留共享主干并行内容，不修改原 classifier、规则、断言或预算。Task 的输出内容校验仍直接消费原 envelope filesystem IO，这个读点必须在正常 Task 核心退出前一同接所选内容能力；本片不掩盖该残余。完整 Task／三入口真根／retention／脚本／执行权恢复、A-T7／AC00／A-G、独立 CS adapters 与 M0→M4 继续开放。
