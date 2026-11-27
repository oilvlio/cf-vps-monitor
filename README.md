![Stars](https://img.shields.io/github/stars/oilvlio/cf-vps-monitor?style=for-the-badge&logo=github&label=Stars&color=ffb000) ![License](https://img.shields.io/github/license/oilvlio/cf-vps-monitor?style=for-the-badge&color=blue)

# CF VPS Monitor（oilvlio fork）

轻量 VPS 探针面板：Cloudflare Workers 承载前端、API、实时连接和定时任务，Durable Objects 协调实时状态，Supabase Postgres 保存配置和历史数据，Go Agent 采集服务器指标。

基于 [kadidalax/cf-vps-monitor](https://github.com/kadidalax/cf-vps-monitor) v2.0.3 维护，做过较大裁剪与增强，见文末「与上游差异」。

## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载（1/5/15 分钟）、温度、网络速率、月度流量、账单与到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：ICMP、TCP、HTTP 任务，可分配到全部或指定节点，展示延迟历史（详情页最多 30 天）。任务可先不分配节点，之后在“服务器视图”里按节点勾选。
- **首页延迟色块**：编辑服务器时可选一个“首页探测点”（需先在 Ping 任务里应用到该节点），首页卡片显示该任务最新 24 次原始采样。
- **后台管理**：节点增删改、批量操作、拖拽排序、Token 轮换、安装命令生成、系统设置、审计日志、改名改密、双重身份验证。
- **通知**：Telegram、SMTP Email、Webhook；支持离线、到期、负载、IP 变更。
- **主题**：内置 `monitor` 和 `aurora`，支持主题包、自定义 CSS；也可在后台填写 GitHub 仓库启用第三方 Monitor 主题（读取其最新 Release 的 `theme.tar.gz`；填写 `https://github.com/owner/repo/releases/tag/vX.Y.Z` 可固定 Release，由 Worker 托管并提供兼容 API 与 WebSocket）。
- **管理员恢复**：忘记账号或密码时，可在登录页用当前部署的 Supabase Secret key 重置唯一管理员。
- **省配额**：有人观看时 Agent 约 3 秒上报，无人时约 120 秒批量上报。可用节点数取决于 Ping 任务、访问量及数据库和实时服务额度，请以平台控制台实际用量为准。

> 温度仅支持 Linux 上可识别的 CPU/SoC 传感器（多个读数取最高值）；无传感器、读取失败，以及 Windows、macOS、FreeBSD 均显示“不可用”。GPU 温度独立显示。

## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI，由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC |
| `agent/` | Go Agent，WebSocket/HTTP 上报，Unix/Windows 安装脚本 |
| `supabase/migrations/` | `1_schema.sql`、`2_functions.sql`，由 `/db-init` 执行 |
| `scripts/` | 部署与迁移清单生成脚本 |

## 运行时配置

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret | Supabase Secret key（`sb_secret_...`）；不要填 Publishable key、anon key |
| `JWT_SECRET` | Secret | 后台会话签名密钥，至少 32 字节（英文/数字不少于 32 个字符） |
| `GH_TOKEN`（可选） | Secret（构建变量） | 避免发布前 CI 检查被 GitHub 限流，见部署流程第 9 步 |

## 面板部署

在 Cloudflare 的 **Settings → Build → Build Variables and Secrets** 中设置 `NODE_VERSION=24`、`GO_VERSION=1.26.11`（与 `agent/go.mod` 一致）。

Workers Builds 发布前会等待 GitHub 上同一提交的 CI（`.github/workflows/ci.yml`）通过，CI 失败或超时则不发布；命令行部署则在本地运行 `npm run verify`。

所有分支的推送和构建均受同一提交的 GitHub CI 门禁保护；CI 通过后 Workers Builds 才会发布。提交到 `main` 的 PR 也运行完整检查，包括浏览器回归。

Fork 构建会从 Git origin（或构建变量 `CF_MONITOR_AGENT_REPOSITORY` / `GITHUB_REPOSITORY`）确定 Agent 仓库；发布包内安装器也会使用发布它的仓库。直接运行源码安装器时可通过 Linux 的 `--repository owner/repo` 或 Windows 的 `-Repository owner/repo` 指定来源。

> **本仓库不保留旧版本数据库迁移。** 从上游或本仓库更早版本升级时，请重建数据库（新建 Supabase 项目，或清空后重跑 `/db-init`），旧数据与旧表不会自动迁移。

### Fork 本仓库部署（推荐，方便更新）

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 在 **Project Overview** 复制 `Project URL`；在 **Project Settings -> API Keys -> Publishable and secret API keys** 复制 **Secret keys** 中的 `default` Secret key（`sb_secret_...`）。
3. Fork [本仓库](https://github.com/oilvlio/cf-vps-monitor)，在你自己的仓库的 **Actions** 页启用 workflows，选择 **Agent Release**，点击 **Run workflow** 填入版本号，生成你自己仓库的 Agent 发行包与安装脚本。
4. 打开 Cloudflare Dashboard 的 **Workers & Pages**，点击 **创建应用程序 → Continue with GitHub**，选择 GitHub 账号和刚才 Fork 出的仓库，点击 **下一步**。
5. 展开 **高级设置**，配置 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`；**构建命令** 保持 `npm run build`，**部署命令** 设为 `npm run deploy`，点击 **部署**。
6. 若 Worker 名称不是 `cf-vps-monitor`，需同步修改 Fork 仓库 `wrangler.toml` 的 `name`，两者必须一致。
7. 在 [Supabase Access Tokens](https://supabase.com/dashboard/account/tokens) 创建 Access Token，打开 `https://你的 Worker 域名/db-init` 初始化数据库。
8. 访问 `/admin/login` 创建管理员。
9. （可选）配置 `GH_TOKEN`：构建日志出现 `GitHub CI gate: GitHub returned HTTP 403; deployment stopped.` 时才需要。原因是 Cloudflare 构建机出口 IP 共用，GitHub 未认证 API 额度（60 次/小时）可能已被用尽；带 token 后为 5000 次/小时。
   1. GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens** 新建 token，**Repository access** 选 **Only select repositories** 并只选你的 Fork 仓库，**Repository permissions** 中将 **Actions** 设为 **Read-only**，不要授予其他权限。
   2. 在 Cloudflare 该 Worker 的 **Settings → Build → Build Variables and Secrets** 添加 `GH_TOKEN`，**类型选 Secret**，保存后重试构建。日志出现 `GitHub CI passed for …` 即生效。
   3. 也识别 `GITHUB_TOKEN`，两者同时存在时优先 `GH_TOKEN`；token 过期后需重新生成并更新。

## 命令行部署

需要 Node.js 24 和 Go（按 `agent/go.mod` 自动选择工具链）。不经过 CI 检查，也不需要 `GH_TOKEN`。

```powershell
npm ci
npm run build
npx wrangler login
$env:SUPABASE_URL="https://xxxx.supabase.co"
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put JWT_SECRET
npm run deploy
```

## 使用流程

1. 登录后台，在“服务器”添加节点。
2. 打开节点安装命令，选择 Unix 自动检测或 Windows，在 VPS 上执行，等待 Agent 上线。
3. 需要 Ping 监控时，在“Ping”创建任务；想在首页看延迟色块，在“服务器”编辑节点并选择“首页探测点”。
4. 需要告警时，在“通知”配置 Telegram、SMTP Email 或 Webhook。

同一台服务器可安装多个 Agent 实例，每个安装命令带独立 `instance-id`，默认生成独立服务名和安装目录。

### Agent 安装说明

Unix 安装命令会自动判断 Linux、Alpine/OpenRC、macOS、FreeBSD 以及 root/非 root 环境。Linux 仅在 systemd 或 OpenRC 实际运行时使用系统服务，否则自动使用用户模式（也可加 `--install-mode user`）。

| 系统 | 预编译架构 | 系统安装 | 普通用户安装 |
| --- | --- | --- | --- |
| Debian/Ubuntu、RHEL 系等 Linux | amd64、arm64 | 活动 systemd | 支持 |
| Alpine/Gentoo 等 OpenRC Linux | amd64、arm64 | 活动 OpenRC | 支持 |
| macOS | Intel、Apple Silicon | LaunchDaemon | 支持 |
| FreeBSD | amd64 | 使用用户模式 | 支持 |
| Windows | x64 | 需要管理员，服务以 LocalService 运行 | 不支持 |

该表只说明安装路径和发行包范围，不代表各发行版、架构均经实机验证。

- **非 root / Serv00 等共享主机**：文件放在用户目录，用 `nohup` 启动；主机允许时添加 `crontab @reboot`，否则提示未配置开机自启。`nohup` 不提供崩溃重启。
- **OpenRC**：系统服务的自定义安装路径必须允许服务账户进入，安装器不会放宽既有私有父目录权限。
- **权限限制**：ICMP 与部分硬件指标取决于系统权限，不等同于上报失败。

卸载单个 Unix 实例：

```bash
wget -qO- 'https://raw.githubusercontent.com/oilvlio/cf-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

`--uninstall-all --yes`（Windows 为 `-UninstallAll -Yes`）才会清理本机全部 Agent 实例。

## 本地开发

```bash
npm ci
npm run dev:frontend
npm run dev:worker
```

常用检查：

```bash
npm run build:migrations
npm run lint          # tsc + ESLint（no-floating-promises / no-empty 等）
npm run format        # Prettier 格式化
npm run verify
cd agent && go test ./...
```

测试布局：Worker 单测集中在 `worker/test/`，目录结构与 `worker/src/` 对应，文件名统一为 `<模块>.<主题>.test.mjs`；需要 Miniflare / Postgres 的集成测试以 `-runtime.test.mjs` 结尾，`npm run test:postgres` 只跑依赖真实 Postgres 的三个用例。

## 安全

- 后台使用 HttpOnly 会话 Cookie，非安全写请求需 CSRF 校验；登录失败会限流并写审计日志。
- Agent 使用请求头 `Authorization: Bearer <节点 Token>` 认证，后台可轮换。WebSocket 上报不再接受 `?token=`；自定义客户端需迁移到请求头，避免凭据进入 URL 日志。仓库最早版本的 Go Agent 已使用请求头。
- Ping 探测拦截内网、回环、链路本地、组播、保留和元数据地址。
- Supabase 迁移启用 RLS，RPC 显式 `revoke` / `grant`，`security definer` 函数固定 `search_path`。
- 重置管理员需要输入当前部署的 Supabase Secret key，仅用于本次校验，不保存。

### Agent 接口

Agent 通过 `/api/clients/report` 上报、`/api/clients/policy` 获取 HTTP 策略，并使用请求头 `Authorization: Bearer <节点 Token>` 认证。WebSocket `REPORT_REJECTED` 会立即结束会话并触发重连，不等待约 90 秒的 ACK 超时；未确认 Ping 结果会重发，普通指标仍是尽力投递。

## 与上游差异

<details>
<summary><b>点击展开：与上游 v2.0.3 的差异</b></summary>

- **移除**：网站监控、后台「一键同步更新 / 版本更新」、GPU 历史（节点 GPU 名称和实时读数保留）。
- **新增**：首页探测点（`/api/ping/home`）；Load5/Load15 上报；第三方 Monitor 主题兼容（兼容 API 与 `/api/ws`）。
- **Agent 参数**：`--allow-host-load`（默认开，`--no-host-load` 关闭）/ `--host-cpu-cores` 用于容器上报宿主负载；`--enable-gpu`（GPU 探测默认关闭）；`--log-level debug|info|warn|error`（默认 info）。容器磁盘直接按 statfs 上报。
- **历史保留**：Host、Ping 原始数据默认保留 168 小时（范围 48–720）；共用 30 分钟 rollup 默认保留 2160 小时（范围 168–8760，且须比原始保留期至少多 2 小时）。写入预算依据真实分区树占用，达到预算后暂停新的历史写入，读取不受影响；设置页的占用预测是线性估算，不是容量保证。
- **数据库**：迁移收敛为 `1_schema.sql` 与 `2_functions.sql`；records、Ping 快照按日分区，rollup 按周分区，过期分区按完整分区回收，实际保留受分区边界影响。Ping 快照按落库间隔全量保存。
- **流量统计**：改为 vnstat 式按天存增量，全部在服务端完成。Agent 只上报网卡内核累计读数，不再有本地流量状态文件，`--traffic-reset-day` 参数已移除；Supabase 按 Agent 本地日期累计到 `traffic_daily`，月度流量为当前计费周期内日增量之和，因此修改重置日只是换求和区间，不会清零。月度总量约每 2 分钟精确落库，期间由 Worker 在内存中估算；仅当落库失败期间节点恰好重启，才会丢失最后一次落库到重启之间的流量。日增量保留约 400 天。
- **升级顺序**：先部署 Worker 并重新执行 `/db-init`（幂等），再升级 Agent；旧 Agent 的本地流量历史会随第一批上报一次性导入，旧服务需重跑安装命令更新服务单元。Agent 先于 Worker 升级时，面板会暂时显示“开机以来”的累计值，待服务端就绪后自动恢复。
- **安全基线**：Go 1.26.11、undici 7.30.1、sharp 0.35.5。

</details>

## 许可证

本项目使用 [MIT License](LICENSE)。
