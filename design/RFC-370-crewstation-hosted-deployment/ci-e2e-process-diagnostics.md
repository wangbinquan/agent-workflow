# RFC-370：原 E2E 进程归属与超时取证

## 原 hosted 结果

精确 `2e6715102882988376bdba8b1e1171ecfa69293b` 的主 CI `37965012479` 已正式 failure；同 SHA 完整手工 Windows `37965611777`／job `113939082074` 为 success，四个工作区 typecheck 都实际 exit 0。主 CI 的全部 72 个作业和完整 Windows 单作业已逐一比较；主 CI 64 success、8 failure，没有把 Windows 单独成功记为总绿。

三平台前台 shard 3 的刷新测试已经进入新 header 错误分支，实际失败在 `rfc371-report-refresh-display.test.tsx:768`：返回 502 后旧 snapshot 仍存在。趋势 Enter 钻取和报告替换后焦点丢失仍需前台 owner 修复；该会话已收到这次必要的同文件 CI 协调。

Windows e2e job `113938774235` 还保留原 Task running 的 10_000ms／pending、failed 的 60_000ms／running 失败，原 Claude timeout 用例首次 45_000ms 后仍 running，随后重试成功不替代根因闭合。该 job 实际记录十一条 `event loop stalled`，gap 为 1025～2133ms；仅据此不能认定所有超时的原因。

Mac e2e job `113940837335` 的 INTENT-13b 夹具在原 daemon ready 30 秒预算失败。实际 stdout 已走到 digital employee writer 激活，但没有 ready 行；原失败及其全文日志保留。

## 本片改动

原意图共享夹具以一个 `Promise.all` 同时启动三个 fresh daemon，再整体赋值到三个句柄。任一启动拒绝时，整体赋值不会发生，原 afterAll 无法获取已经成功的句柄。本片保留三个原启动的并行次序、stub 配置与 `Promise.all` 的原拒绝传播；每个实际成功的句柄立即登记。afterAll 先标记清理，再并行调用已登记句柄的原真实 stop，并等待所有启动落定。清理开始后才成功的句柄由原启动回调直接 stop，不加入已登记集合，因此没有 late-success 遗漏或同一句柄二次 stop。失败的 startDaemon 仍由原 harness 清理原 child 并重抛。

独立 R1 功能门发现串行启动会超过 beforeAll 的独立 90_000ms 预算，本次已撤下本会话该候选，正式 FAIL 与完整失败正文保留。原 ready 默认预算按平台分列为 POSIX 30_000ms、Windows 90_000ms；beforeAll／afterAll 各自的独立 90_000ms 与原 300_000ms case 预算保持。三个 Windows 各需 40 秒的启动仍并行完成，不相加成 120 秒。全部原案例、断言、轮询与配置保持，只有夹具登记和清理钩子按上述真实归属修正。

已只读核对原 Playwright 1.60.0 worker：suite 在 beforeAll 运行前登记，失败和 Worker Cleanup 仍调用 afterAll；hook timeout 不取消待完成的启动。因此清理标志必须在读取已成功句柄之前写入，afterAll 也需等待原 pending 启动。源码依据为 `node_modules/.bun/playwright@1.60.0/node_modules/playwright/lib/worker/workerProcessEntry.js:3065-3198`；独立 hook slot 见该文件 3161 行。未执行该 worker 或测试模块。

原 Task 状态 waiter 和 runtime scenario waiter 只在原超时错误末尾附加现有 `daemon.diagnostics()` 的实际 PID、exit／signal、post-ready stdout／stderr tails。原轮询、成功返回、错误前缀、Task 最后状态、API／WS／UI 断言、runtime 的两个 attempt 与无 late output 判据、所有预算不改。没有增加网络查询或重试，也没有改变原 harness、产品代码或 CI 命令。

## 验收边界

源码只改三个 E2E 文件；旧全文 beforeimage、完整 scoped inverse、案例／预算保持与精确格式检查作为有限证据。独立功能实现门、精确发布及新 hosted 主 CI／完整 Windows 仍另验；诊断增强不签 Windows 超时已修复。

没有本机 AW tests／typecheck／build／service／E2E，没有新 census。生命周期 L 的 SOURCE18-R2 已实际完整消费并保持，唯一 L census 尚未启动。完整 H7／A-T7／A-G、十九 owner／三 roots、各层 CS adapter 与 M0～M4 仍开放，AW 尚未部署 CS，RFC 继续。
