# CI PostgreSQL 获取与启动

精确 `ab9316c7c9ce3bf799689f941b5e26287b6ea0fe` 的主 CI `38135435138`，Ubuntu 31/32 作业 `114458223530` 在测试和 checkout 前连续三次拉取 `public.ecr.aws/docker/library/postgres:17`，均收到 `toomanyrequests: Data limit exceeded`。原 5,062 字节日志 SHA256 为 `dc82688109d39e5ef3dbbc0c69ec8785044f5b8b8b1543581eeae070acd94e5f`。早先 Docker Hub 的 token 超时与匿名限额记录仍在原镜像来源文档，不把改回单一来源或重跑视为修复。

同一 SHA 的原 Typecheck 作业 `114458223083` 已正式 success；实际完整日志记录 `NODE_OPTIONS=--max-old-space-size=6144`，四工作区分别退出 code 0。该日志 67,645 字节、SHA256 `a3e02b6fdcf3b5be959fd354e91ad52b544b908ae84ddc01d61ade6b8c2544bb`。这只验收堆配置，主 CI 与完整 Windows 总绿仍待验收。并行观测修复已发布到其后继 `bbc2347fb2e730d3a420f9ccb1b9ccd7b291bca0`，不将对方提交消息代替实际 CI 结果。

只改变主 CI 原两处 PostgreSQL 的获取与启动：Ubuntu 的全部 32 个 backend 分片和独立 real PostgreSQL 作业。Actions 在用户 steps 前启动声明式 services，原失败发生在这个阶段；因此将这两处启动移到 checkout 后的显式 bash 步骤，由同一个 `.github/scripts/ci-postgresql-service.sh` 执行。

启动步骤先保留 runner 原 Docker daemon JSON 的所有其他配置，将 Google 官方 Docker Hub 缓存 `https://mirror.gcr.io` 放到 registry-mirrors 首位，重启本作业的 Docker daemon，再请求原 Docker Official Image 的 `docker.io/library/postgres:17`。这是 Google 文档指定的 daemon 接入方式：缓存命中则取缓存，未命中由 Docker 继续请求 Docker Hub。不能假定特定镜像永久在缓存中，也不直接把服务 image 换成缓存域名。

若该次拉取失败，显式尝试原 ECR Public 的同一 Docker Official Image `17` 标签；两个获取命令各设 120 秒网络等待上限，仍在原 15 分钟作业预算内，不改变任何测试预算。两个来源都失败则启动步骤失败，测试不得继续。缓存与备用来源提高获取可用性，不承诺外部仓库永远可用；保留原 `17` 标签更新策略，不新增固定 patch 或私有镜像发布。

拉取成功后才以所选本地镜像运行容器，明确 `--pull=never`，避免启动时再发起一次下载。容器保留原 `POSTGRES_PASSWORD=postgres`、各自 `awtest`／`rfc357` 数据库、`5432:5432` 和完整 health 配置：`pg_isready -U postgres`、interval 5s、timeout 5s、retries 20。等待 Docker 的原 health 状态变为 healthy，starting 时继续观察；unhealthy 或容器状态读取失败即失败，不将未就绪当成功。成功时记录所选 image、RepoDigests 与容器内 PostgreSQL 版本，并确认主版本 17。

容器使用本作业固定名称 `aw-ci-postgresql`。两个作业在原 steps 后追加 `always()` 清理，只在启动步骤确实执行后运行：先输出容器日志，再删除该容器。无其他作业容器依赖此服务；原 URL 都使用 runner 的 `127.0.0.1:5432`，没有 service 网络别名或 `job.services` 调用。macOS 启动与清理均跳过，原 SQLite-only 环境保持。

原 matrix、全部 72 个主 CI 作业、聚合门、Typecheck 与原四工作区输入、Bun／依赖、所有原测试命令与环境、SQL 连接探针、双 provider 和 real PostgreSQL 不可 skip 判据、覆盖率、上传与全部测试／作业预算保持。Windows 配置和全部 AW 生产／测试源码不属于本次改动。实现后以纯 YAML／字节检查验证原配置逆变换，bash 仅做语法检查；不运行本机 AW 测试、类型检查、构建、服务、E2E 或新 census。

功能依据于 2026-10-11 实际读取的 Google Cloud Documentation「Pull cached Docker Hub images」的 daemon 配置与拉取顺序；来源文本为 `https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images`。原 runner 行为依据公开源码 `actions/runner/src/Runner.Worker/ContainerOperationProvider.cs:176-202,388-406`：同一 image 最多三次拉取、health 为 starting 时继续等待、只接受 healthy。

CI 微调按原批准范围实施；独立有限功能设计与实现门、精确三路径发布和后继同 SHA 完整主 CI／默认完整 Windows 分别验收。后继需消费 637 次原目标具名执行（H／L／R／SO 568 次及原 boot 69 次）；不以当前部分成功代签。Task 装配设计保持，完整 H7／十九 owner／三个启动根、A-T7／A-G、各层 CS adapter 和先 M0 再 M1～M4仍开放。AW 尚未部署 CS，RFC-370 未完成。
