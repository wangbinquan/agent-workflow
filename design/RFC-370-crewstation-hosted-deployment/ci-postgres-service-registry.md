# CI PostgreSQL 服务镜像来源

精确 `bfd76107e95797e3cba2ab41880f645e27f8d485` 的主 CI `37992683683` 中，Ubuntu backend shard 7 job `114030646262` 在初始化服务容器时失败。原始作业日志先记录 Docker Hub token 请求超时，后记录 `toomanyrequests` 和匿名拉取限额；该作业尚未执行测试。日志与作业元数据完整保留，不把这次供给失败记作业务测试回归或成功。原流水线继续等终态，完整默认 Windows 单独验收。

只将 `.github/workflows/ci.yml` 的两处原 PostgreSQL 服务镜像从 `postgres:17` 改为 `public.ecr.aws/docker/library/postgres:17`：Ubuntu 的 32 个 backend 分片与独立 real PostgreSQL 作业。原 macOS 空镜像分支、matrix、数据库、端口、health check、连接探针、双 provider 测试、真实 PostgreSQL 不可 skip 判据、测试命令、聚合门及全部预算保持。

AWS 的 Docker Official Images 公告提供 ECR Public 镜像来源依据；同时于 2026-10-10 05:32（北京时间）实际读取两站 `17` 标签的完整 OCI index 和 Linux amd64 manifest。两站 index 均为 10,237 字节、SHA256 `2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`，amd64 manifest 均为 3,628 字节、SHA256 `3cec7eb015ba8adb28139fa5c83b8489cdf0e666e53dfdf20f598ae0cc8739e3`，与 index 中 descriptor 的 digest／size 一致。其声明的版本为 PostgreSQL 17.11。ECR 响应未提供 Docker-Content-Digest header，等价结论来自实际完整字节及 descriptor，未虚构该 header。这里保留原 `17` 标签更新策略；不能承诺两个站点未来永远同步。仅查询远端 manifest，没有本机镜像拉取、容器或 AW 产品执行。

来源：AWS Containers Blog 的 [Docker Official Images now Available on Amazon Elastic Container Registry Public](https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/)，以及上述两站实际 manifest。原失败、有限独立功能设计／实现门、精确三文件发布、新 SHA 完整主 CI／默认 Windows分别验收；替换来源本身不代签总绿。生命周期 L 候选保持未发布，211 个新 case 未签收，RFC-370 与 AW 在 CS 的部署继续开放。
