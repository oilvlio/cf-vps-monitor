![Stars](https://img.shields.io/github/stars/kadidalax/cf-vps-monitor?style=for-the-badge&logo=github&label=Stars&color=ffb000) ![Forks](https://img.shields.io/github/forks/kadidalax/cf-vps-monitor?style=for-the-badge&logo=github&label=Forks&color=2ea44f) ![License](https://img.shields.io/github/license/kadidalax/cf-vps-monitor?style=for-the-badge&color=blue)
# CF VPS Monitor

CF VPS Monitor 是一个轻量 VPS 探针面板，使用 Cloudflare Workers 承载前端、API、实时连接和定时任务，使用 Durable Objects 协调实时状态，使用 Supabase Postgres 保存配置和历史数据，使用 Go Agent 在服务器上采集指标。


## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载、温度、网络速率、月度流量、账单、到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，可分配到全部节点或指定节点，并展示延迟历史。任务可以先不分配任何节点就创建（暂不运行），之后在“服务器视图”里按节点勾选要运行的任务；全局任务跟随所有节点，需先在任务里关闭“所有服务器”才能逐台调整。
  - 详情页 Ping 图表：12 小时内画原始点；更长窗口由服务端分桶（1 天/3 天为 6 分钟，7 天为 14 分钟，约 720 点，步长是 120 秒的整数倍，60 秒/120 秒探测间隔都整除），曲线取桶内中位数（不取整），可开启“极值带”查看每桶的最小～最大延迟。任务卡片的均值/最小/最大/P75/丢包/抖动（延迟标准差）由服务端对整个窗口的原始样本计算。历史数据在页面内缓存 5 分钟。
  - 更新到这一版后需要打开 `/db-init` 执行一次数据库升级（新增 `cfm_ping_stats_for_tasks_range`，分桶代表值由取整平均改为不取整中位数）。
- **首页延迟/丢包色块**：在后台编辑服务器时，可为节点勾选一个“首页探测点”（需先在 Ping 任务里应用到该节点），首页节点卡片会显示该探测任务的延迟与丢包色块（每格 5 分钟，约 2 小时）。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、记录清理、Agent Token 轮换、安装命令生成、系统设置、审计日志、健康检查、容量估算、备份恢复、账号改名和改密。
- **通知**：支持 Telegram 、 SMTP Email 和 Webhook，可配置离线、到期和负载通知。
- **主题**：内置 `monitor` 和 `aurora` 主题，支持主题包、自定义 CSS、图片和字体资源。
- **管理员恢复**：首次登录时创建管理员；忘记账号或密码时，可在登录页用当前部署的 Supabase Secret key 重置唯一管理员。
- **省配额策略**：有实时观看者时 Agent 约 3 秒采集并上报；无人查看时约 120 秒采样并批量上报。可用节点数取决于 Ping 任务、访问量、上报方式以及数据库和实时服务的独立额度，请在后台容量估算中核对，不能仅凭 Worker 请求量保证免费运行 50 台。

节点温度目前仅支持 Linux 上可识别的 CPU/SoC 传感器，多个有效读数取最高值。没有传感器或读取失败，以及当前 Windows、macOS、FreeBSD 安装包，均显示“不可用”；真实 0°C 和负温度仍是有效读数。GPU 温度独立显示。旧 Agent 需要升级才能使用这一规则，旧历史中的 0 不会被猜测改写。

## 预览图

<img width="960" height="540" alt="cf-vps-monitor-promo-full-mobile" src="https://github.com/user-attachments/assets/78a5c78b-143c-4874-aa6e-4dbe17c3597d" />



## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI，构建产物由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC 数据层 |
| `agent/` | Go Agent，支持 WebSocket/HTTP 上报和 Unix/Windows 安装脚本 |
| `supabase/migrations/` | Supabase 表、索引、RLS、RPC、授权和默认数据 |
| `scripts/` | 部署和迁移清单生成脚本 |

## 运行时配置


| 名称                    | 类型       | 说明                                                                    |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `SUPABASE_URL`        | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co`                    |
| `SUPABASE_SECRET_KEY` | Secret   | Supabase Secret key，通常以 `sb_secret_` 开头；不要填写 Publishable key、anon key |
| `JWT_SECRET`          | Secret   | 后台会话签名密钥，必须至少 32 字节；英文/数字不少于 32 个字符                                   |

`SUPABASE_SERVICE_ROLE_KEY` 仅作为旧部署兼容变量保留；新部署请使用 `SUPABASE_SECRET_KEY`。

## 面板部署

在 Cloudflare 的 **Settings → Build → Build Variables and Secrets** 中设置 `NODE_VERSION=24`、`GO_VERSION=1.26.9`（与 `agent/go.mod` 保持一致）。Workers Builds 官方镜像已包含 Go，也能按 `go.mod` 自动选择工具链。部署入口会先运行前后端检查、构建和 JavaScript/Go 测试；检查失败时不会发布。

### Fork 原仓库部署【推荐，方便更新】


1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. Fork [本仓库](https://github.com/kadidalax/cf-vps-monitor)， 创建自己的仓库。到Actions 选择**Agent Release** 点击**Run workflow** 填入创建自己的版本号，再次点击**Run workflow** 创建自己仓库的Agent 安装脚本。
4. 打开 Cloudflare Dashboard 的 **Workers & Pages**，点击 **创建应用程序**， 点击**Continue with GitHub**。
5. 选择 GitHub 账号和刚创建的 Fork 仓库，点击**下一步**。
6. 展开 **高级设置** 配置三个变量 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
7. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
8. 点击 **部署**。
9. 如果 Cloudflare 里创建的 Worker 名称不是 `cf-vps-monitor`，需要同步修改 Fork 仓库的 `wrangler.toml` 里的 `name`，两者必须一致。
10. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
11. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。



### 直接一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kadidalax/cf-vps-monitor)

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. 点击 上面的**Deploy to Cloudflare**。
4. 登录 Cloudflare, 选择账号、仓库名和 Worker 名称。
5. 填入对应变量的值 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
6. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
7. 点击 **部署**。
8. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
9. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。
10. 建议后续每次版本更新后都执行一次初始化数据库(不会丢失数据)。


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
3. 打开节点安装命令，选择 Unix 自动检测或 Windows。复制安装命令。请确认你的安装脚本指向的仓库有效且你已经在actions里运行了创建agent脚本的workflow。
4. 在 VPS 上执行安装命令，等待 Agent 上线。
5. 需要 Ping 监控时，在“Ping”创建任务。
6. 想在首页节点卡片上看到延迟/丢包色块时，在“服务器”编辑该节点，选择“首页探测点”。
7. 需要告警时，在“通知”配置 Telegram、SMTP Email 或 webhook推送。


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
wget -qO- 'https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

只有执行 `--uninstall-all --yes` 或 `-UninstallAll -Yes` 才会清理本机全部 Agent 实例。

## 数据库迁移精简说明

`supabase/migrations` 由原来的 11 个文件合并为 3 个，部署后同样需要打开本站 `/db-init` 执行一次数据库升级：

- `1_schema.sql`：表、列、约束、索引、RLS 与权限、默认数据，以及存量库的一次性数据修正；
- `2_functions.sql`：全部 RPC 函数的最终定义和统一的 EXECUTE 授权；
- `3_legacy_cleanup.sql`：清理已下线功能的遗留对象。全新安装时全部是 no-op，所有部署都升级过之后可以整个删除。

升级前后的业务数据（账号、节点、历史、通知配置等）不受影响，旧的 11 个迁移登记会被清掉。以下遗留对象会被处理：

- 网站监控：相关函数已删除。**网站监控表里如果还有数据，会原样保留**（不再有任何代码读取）；表为空时才会被删除。
- 备份：新生成的备份不再包含网站监控；仍带有 `website_monitors` 的旧备份文件可以正常还原，该部分会被忽略。
- 早期 rollup 方案的 `records_rollup` / `ping_rollup` 两张从未写入过的空表、以及从未被调度执行的 `cfm_compact_history`，一并移除。

### 从 v2.0.2 升级到 v2.0.3

1. 部署完成后，立即打开本站 `/db-init` 执行一次数据库升级。已有账号、节点及有效监控数据保留，无需清库或重建节点；本版本新增迁移 `9_home_ping_task`（首页探测点，现已并入 `1_schema.sql` / `2_functions.sql`），不执行这一步时，后台“首页探测点”下拉框会提示需要升级数据库。网站监控功能已移除，原有网站监控数据会作为不再使用的表保留在数据库中，不会被删除。
2. 原先使用非每月 1 日重置流量的节点，先在后台确认“流量重置日”，再更新 Agent。使用后台为原节点生成的新版安装命令原地更新即可，安装器会重启 Agent，无需重启 VPS。Agent 不会自动更新；旧版 Agent 仍可正常上报指标和 Ping。
3. 首次升级 Agent 会重建流量统计基线，累计值可能降低或重新起算；修改流量重置日也会重建当期累计。

### 如果是 Fork 原仓库部署【推荐】

适合先 Fork 官方仓库，再在 Cloudflare Workers Builds 里连接这个 Fork 仓库的部署方式。

1. 在后台 `关于 -> 版本更新`：
   - `你的部署仓库地址` 填你的 Fork 仓库地址，例如 `https://github.com/用户名/cf-vps-monitor`
   - 点击 `保存设置`
2. 后台检测到更新后，点击 `前往同步 Fork`，打开你的 Fork 仓库首页。
3. 在 GitHub 仓库文件列表上方点击 `Sync fork` 下拉菜单。
4. 确认上游提交后点击 `Update branch`。
5. 如果 GitHub 提示冲突，需要按提示创建 PR 或手动解决冲突。
6. Fork 更新产生的 push 会触发 Cloudflare Workers Builds 自动构建部署。
7. **更新后最好初始化一下数据库，否则可能无法使用**

### 如果是 Deploy Button 一键部署

Cloudflare 一键部署自动创建的仓库不保证包含可用的更新工作流，后台不再提供这类更新入口。需要后续稳定同步更新时，建议改用上面的 Fork 原仓库部署方式。


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

- [Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Supabase Data API Security](https://supabase.com/docs/guides/api/securing-your-api)


## Star History

<a href="https://www.star-history.com/?repos=kadidalax%2Fcf-vps-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=kadidalax/cf-vps-monitor&type=date&legend=top-left" />
 </picture>
</a>
