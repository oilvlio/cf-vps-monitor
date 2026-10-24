![Stars](https://img.shields.io/github/stars/oilvlio/cf-vps-monitor?style=for-the-badge&logo=github&label=Stars&color=ffb000) ![License](https://img.shields.io/github/license/oilvlio/cf-vps-monitor?style=for-the-badge&color=blue)
# CF VPS Monitor（oilvlio fork）

CF VPS Monitor 是一个轻量 VPS 探针面板，使用 Cloudflare Workers 承载前端、API、实时连接和定时任务，使用 Durable Objects 协调实时状态，使用 Supabase Postgres 保存配置和历史数据，使用 Go Agent 在服务器上采集指标。

本仓库基于 [kadidalax/cf-vps-monitor](https://github.com/kadidalax/cf-vps-monitor) v2.0.3（上游已归档）维护，按自身需求做过大幅裁剪与增强，细节见文末「与上游差异」。

## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载（1/5/15 分钟）、温度、网络速率、月度流量、账单、到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，可分配到全部节点或指定节点，并展示延迟历史。任务可以先不分配任何节点就创建（暂不运行），之后在“服务器视图”里按节点勾选要运行的任务；全局任务跟随所有节点，需先在任务里关闭“所有服务器”才能逐台调整。
  - 详情页 Ping 图表：12 小时内画原始点；更长窗口由服务端分桶（1 天/3 天为 6 分钟，7 天为 14 分钟，约 720 点），桶内取不取整中位数。任务卡片的均值/最小/最大/P75/丢包/抖动（延迟标准差）由服务端对整个窗口的原始样本计算。历史数据在页面内缓存 5 分钟。
- **首页延迟色块**：在后台编辑服务器时，可为节点勾选一个“首页探测点”（需先在 Ping 任务里应用到该节点），首页节点卡片会显示该探测任务最新的 24 次原始采样色块（不聚合，右端为最新）。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、记录清理、Agent Token 轮换、安装命令生成、系统设置、审计日志、健康检查、容量估算、备份恢复、账号改名和改密。
- **通知**：支持 Telegram、SMTP Email 和 Webhook，可配置离线、到期和负载通知。
- **主题**：内置 `monitor` 和 `aurora` 主题，支持主题包（CSS + 图片 + 字体资源）、自定义 CSS 和可配置变量。
- **管理员恢复**：首次登录时创建管理员；忘记账号或密码时，可在登录页用当前部署的 Supabase Secret key 重置唯一管理员。
- **省配额策略**：有实时观看者时 Agent 约 3 秒采集并上报；无人查看时约 120 秒采样并批量上报。Ping 历史按落库间隔全量保存，无「值不变不落库」压缩。可用节点数取决于 Ping 任务、访问量、上报方式以及数据库和实时服务的独立额度，请在后台容量估算中核对。

节点温度目前仅支持 Linux 上可识别的 CPU/SoC 传感器，多个有效读数取最高值。没有传感器或读取失败，以及当前 Windows、macOS、FreeBSD 安装包，均显示“不可用”；真实 0°C 和负温度仍是有效读数。GPU 温度独立显示。

## 与上游差异

- **移除**：网站监控（页面、API、定时探测、通知与数据库对象全部下线）；后台「一键同步更新 / 版本更新」入口。
- **新增**：首页探测点（`/api/ping/home` + 首页色块）；Agent `--allow-host-load` / `--host-cpu-cores`（容器上报宿主负载并按核数折算）；`--disable-gpu`（安装器含开关）；Load5/Load15 三元组上报。
- **行为调整**：Ping 快照按落库间隔全量落库（含丢包/超时事件即时落库）；容器磁盘直接按 statfs 上报（移除目录扫描 / 配额换算 / root 收集器）；记录与 Ping 历史保留上限 168h（默认 168h）；超过 24h 的 GPU 历史自动并入小时桶 `gpu_rollup` 节省存储。
- **安全基线**：Go 1.26.10（GO-2026-6809）、undici 7.30.1、sharp 0.35.5 overrides。
- **数据库**：迁移收敛为 2 个「全新安装终态」文件，不含旧版本存量数据迁移。

## 预览图

<img width="960" height="540" alt="cf-vps-monitor-promo-full-mobile" src="https://github.com/user-attachments/assets/78a5c78b-143c-4874-aa6e-4dbe17c3597d" />

## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI（已移除 Tailwind，主题样式内聚在 `index.css`），构建产物由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC 数据层 |
| `agent/` | Go Agent，支持 WebSocket/HTTP 上报和 Unix/Windows 安装脚本 |
| `supabase/migrations/` | `1_schema.sql`（表、列、约束、索引、RLS 与授权、默认数据）与 `2_functions.sql`（全部 RPC 及其 EXECUTE 授权），均为全新安装终态 |
| `scripts/` | 部署和迁移清单生成脚本 |

## 运行时配置

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co` |
| `SUPABASE_SECRET_KEY` | Secret | Supabase Secret key，通常以 `sb_secret_` 开头；不要填写 Publishable key、anon key |
| `JWT_SECRET` | Secret | 后台会话签名密钥，必须至少 32 字节；英文/数字不少于 32 个字符 |

## 面板部署

在 Cloudflare 的 **Settings → Build → Build Variables and Secrets** 中设置 `NODE_VERSION=24`、`GO_VERSION=1.26.10`（与 `agent/go.mod` 保持一致）。Workers Builds 官方镜像已包含 Go，也能按 `go.mod` 自动选择工具链。部署入口会先运行前后端检查、构建和 JavaScript/Go 测试；检查失败时不会发布。

> **本仓库不保留旧版本数据库迁移。** 全新部署照常在 `/db-init` 初始化数据库；如果你从旧版本（上游或本仓库更早版本）升级，请重建数据库（新建 Supabase 项目或清空后重跑 `/db-init`），迁移不会自动搬运或清理旧数据与旧表。

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key（格式 `sb_secret_...`）。
3. 在 GitHub Actions 选择 **Agent Release**，点击 **Run workflow** 填入版本号，生成 Agent 发行包与安装脚本。
4. 在 Cloudflare Dashboard 的 **Workers & Pages** 连接本仓库创建 Worker（构建命令 `npm run build`，部署命令 `npm run deploy`）。
5. 配置 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`（至少 32 字节）。
6. 若 Worker 名称不是 `cf-vps-monitor`，需同步修改 `wrangler.toml` 的 `name`。
7. 在 [Supabase Access Tokens](https://supabase.com/dashboard/account/tokens) 创建 Access Token，打开 `https://你的 Worker 域名/db-init` 初始化数据库。
8. 访问 `/admin/login` 创建管理员。

## 命令行部署

适合本地开发或维护者。需要 Node.js 24 和 Go；Go 会依据 `agent/go.mod` 自动选择所需工具链。

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

1. 登录后台。
2. 在“服务器”添加节点。
3. 打开节点安装命令，选择 Unix 自动检测或 Windows，复制后在 VPS 上执行，等待 Agent 上线。
4. 需要 Ping 监控时，在“Ping”创建任务。
5. 想在首页节点卡片上看到延迟色块时，在“服务器”编辑该节点，选择“首页探测点”。
6. 需要告警时，在“通知”配置 Telegram、SMTP Email 或 Webhook。

同一台服务器可以安装多个 Agent 实例。每个安装命令会带独立 `instance-id`，默认生成独立服务名和安装目录。

Unix 安装命令会自动判断 Linux、Alpine/OpenRC、macOS、FreeBSD，以及 root/非 root 环境。Linux 只有在 systemd 或 OpenRC 实际运行时才使用对应系统服务；没有可用服务管理器的容器会自动使用用户模式。也可加 `--install-mode user` 明确选择用户模式。

| 系统 | 预编译架构 | 系统安装 | 普通用户安装 |
| --- | --- | --- | --- |
| Debian/Ubuntu、RHEL 系等 Linux | amd64、arm64 | 活动 systemd | 支持 |
| Alpine/Gentoo 等 OpenRC Linux | amd64、arm64 | 活动 OpenRC | 支持 |
| macOS | Intel、Apple Silicon | LaunchDaemon | 支持 |
| FreeBSD | amd64 | 使用用户模式 | 支持 |
| Windows | x64 | 需要管理员，服务任务以 LocalService 运行 | 当前不支持非管理员安装 |

该表说明安装路径和发行包范围，不代表每个发行版、架构都经过实机验证。其他架构需要自行提供适配二进制或编译环境；未运行 systemd/OpenRC 的 Linux 不提供原生 SysV/runit 服务接入。

非 root 或 Serv00 这类共享主机会把程序、配置和日志保存在用户目录，用 `nohup` 启动后台进程。主机允许时会添加 `crontab @reboot`；缺少 crontab 或账号无权读写时，Agent 继续运行并明确提示未配置开机自启，不覆盖原有任务。`nohup` 不提供崩溃重启，开机自启还取决于主机是否启用 cron、是否允许常驻进程。

OpenRC 每次启动会准备服务账户专用日志并检查启动后进程存活，日志保留已有内容。系统服务的自定义安装路径必须允许服务账户进入；安装器不会放宽既有私有父目录权限。ICMP 与部分硬件指标取决于系统权限，不应把这些限制误当成 TCP/HTTP 或普通指标上报失败。

卸载单个 Unix 实例：

```bash
wget -qO- 'https://raw.githubusercontent.com/oilvlio/cf-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

只有执行 `--uninstall-all --yes` 或 `-UninstallAll -Yes` 才会清理本机全部 Agent 实例。

## 本地开发

```bash
npm ci
npm run dev:frontend
npm run dev:worker
```

常用检查：

```bash
npm run build:migrations
npm run verify
cd agent && go test ./...
```

## 安全

- 后台登录使用 HttpOnly 会话 Cookie，非安全写请求需要 CSRF 校验。
- 登录失败会记录限流状态和审计日志。
- Agent 使用节点 Token 认证，后台可轮换节点 Token。
- Ping 探测会拦截内网、回环、链路本地、组播、保留地址和元数据地址。
- Supabase 迁移启用 RLS，并对 RPC 函数显式 `revoke` / `grant`；需要 `security definer` 的函数固定 `search_path`。
- 忘记密码重置需要输入当前部署的 Supabase Secret key；该 key 只用于本次请求校验，不会被保存。

## 许可证

本项目使用 [MIT License](LICENSE)。

## 参考文档

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Data API Security](https://supabase.com/docs/guides/api/securing-your-api)
