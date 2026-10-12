# CI：真实自定义事件观察器的原程序超时诊断

`9c792382e868660fe752efe6887726f803650560` 的默认完整 Windows `38143747959` 已正式 failure。作业 `114482710824` 的平台套件有 1330 pass、3 个原平台 skip、1 fail；唯一实际失败是 `rfc310-event-center.test.ts` 的真实全局自定义源 validate／publish／订阅／轮询／去重用例。原始日志为 352489 bytes，SHA256 `6e2837786da503b8f400385453d89215818f53d77dacabcb61368155d3f9692f`，完整 EOF 已读取；实际失败为 `observer script failed: timeout/1`，用例耗时 11177.48ms。后续步骤因前项失败而 skipped，不能签默认完整 Windows 或八条 typecheck 成功。

此次失败发生在单次真实程序的原 10000ms 上限；该完整用例的 50000ms 整段预算保持。之前为四次串行程序设置整段预算的理由和失败记录见 `custom-observer-program-ci-repair.md`，本次不再次延长任何上限。原脚本读取输入文件、打印一个完整 JSON envelope 后应自然退出；当前异常仅带 outcome／exitCode，没有 stderr 内容，尚不能区分未收到脚本执行输出、脚本内部停顿和完成正文后未结算进程。不能据此宣称平台故障、随机失败或已有修复。

## 有限诊断修改

只在该用例的原真实 Node 脚本内增加两条 stderr 诊断：import 后、读取输入前打印 `RFC-370 native observer started`，同时记录该实际子进程的 pid、execPath 与 Node version；打印原 JSON envelope 后打印 `RFC-370 native observer completed`。只使用脚本现成的 `process` 与 `console.error`，没有新 import、异步等待、监听器、计时器、stdin 或退出调用。

完整保留原 source 业务正文及其 stdout、默认 native factory 选择、原 interpreter／workspace／managed-process 路径、输入、四次真实程序、全部业务断言、同一 rejection 的诊断 catch，以及全部程序／用例／workflow 预算。应用在失败时原本就将非空 stderrTail 附入错误，原 catch 原样打印并重新抛出；成功时 stdout envelope 和 Event Center 的验证、发布、订阅、游标、去重及退役判据不变。生产源码、workflow 和所有其它 case 不改，不增加 public contract、测试数量或 census。

如果下一次仍失败，仅以实际捕获的标记说明程序到达了哪些点；没有标记不能单独证明子进程没有启动，两个标记也不能代签实际进程已经退出。成功只签该新 SHA 在原预算内的实际完整执行，不把这两条诊断称为超时根因修复。

## 验收与交付

先做有限独立功能设计门；实施后以完整源码 inverse 证明移除两条新增诊断便精确恢复本次真正原测试全文，再做 scoped format／lint、纯语法核对和独立实现门。不运行本机 AW tests／typecheck／build／service／E2E／程序。精确发布仅本说明与原测试文件，所有共享 Task 草稿和 RFC-371 用量持久化内容留给各自当前任务。

当前主 CI `38143668661` 继续到原完整终态，不因 Windows 失败取消或重启。新 SHA 的主 CI、默认完整 Windows、八条工作区 typecheck 与 637 次原目标具名执行各自实际验收；原失败和原门历史保留。若仍有实际失败继续必要排障，不放宽断言、不跳过程序、不增加业务预算。总绿前不继续 RFC-370 的下一批生产适配；完整 Task／H7／三个根／十九 owner／A-T7／A-G、各层 CS adapter、M0 首次部署和 M1～M4 仍待完成，AW 尚未部署 CS。

## 设计门后补充

上述继续到终态的主 CI `38143668661` 已正式 completed／success，根已核对同一 `9c792382` 的全部 72 个作业。Ubuntu／macOS 的 W8 各十个实际 case 均 pass，原 macOS commit stub case 在原预算内实际 pass／17.74ms；同 SHA 默认完整 Windows 仍为 failure，不能代签本批总绿、八条 typecheck 或 637 次验收。有限设计门已有效、稳定 PASS／零 findings，原设计全文及失败保持；本次两条 stderr 诊断尚未在 hosted CI 运行，实施门与新 SHA 验证继续。

## 2026-10-13 实际进程结算的有限诊断

最新已同步主干 `1d380944b70ec834d9aacd86682ba0efbda451ff` 的默认完整 Windows run `38287855187`、job `114940424702` 已终态 failure：1491 pass、3 skip、15 fail。原真实全局自定义源用例在第一处 validate 报 `observer script failed: timeout/1`，耗时 15590.83ms；原始日志 572573 bytes，SHA256 `add07adc8bae0280abf5098299600917757bde2d2ee61885318e073e4445a09f`，实际故障上下文在原始行 589–622。其余十四项失败与上一轮相同；本会话 SQLite 的二十六项直接计数回归在原始行 654–679 全部通过。主 CI `38287855347` 尚未终态，已有观测格式和 UI 失败，不能签总绿。

该原生观察器、managed-process、process 和 platformExec 四个实现文件与此前诊断提交 `0d43da993` 逐字一致；事件脚本运行的完整 argv、cwd、环境、timeoutMs 和 stdout 捕获选项与适配前原实现相同。本次错误没有两条原脚本 stderr 标记，也没有实际 PID、binary、reap 或 drain 信息；不能据此确定子进程未开始、解释器故障、主机故障或本次适配已经排除。先前一次成功不解决当前超时，当前超时也不能仅凭 RFC 名称归属其他会话。

本轮只在该原用例通过原默认 selector 获取同一真实 native factory，并把它显式交回原 `composeEventCenter` 入口。每次 `create` 原样转发同一 input，返回同一完整 effects 对象；只包围其原 `run`，以原 effects receiver 和原 workspace/program 引用调用一次，原结果对象原样返回。失败时记录该真实返回值已具有的固定结算字段及 stdout/stderr 字符数，不另开程序、不探测解释器、不读取程序引用、不改变其他六个成员、异常、清理、正文或进程预算。既有 selector 家族用例仍检查 undefined 默认选择；本次集成用例明确使用该 selector 返回的真实 native 家族，不能把它称为另一个执行实现。

新增诊断不包含原脚本内容、输入文件正文、环境值或完整 stdout/stderr；原验证错误及现有两条 stderr 标记保持。所有原用例名称、全部断言、四次真实执行、10000ms 程序预算和 50000ms 整段预算不变。以完整源码 inverse、语法和格式静态检查记录候选，不运行本机 AW 功能验证，不新增逐片设计或实现门。只有新确切提交的 hosted 日志可以说明实际 PID、所用 binary、进程结算时间及捕获是否为空；这项诊断本身不是超时根因修复或 CI 全绿。
