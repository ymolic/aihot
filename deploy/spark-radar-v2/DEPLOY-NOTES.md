# Spark 雷达 v2 部署手册（oracle-us-apps）

自用部署，代码 = 本仓库 `spark-fusion` 分支（AIHOT 上游 77cdcbf + spark-github 模块 + Spark 雷达行业包）。

## 布局

- 代码：`/srv/apps/spark-radar-v2/repo`（git clone fork，checkout spark-fusion）
- 运行时：`/srv/apps/spark-radar-v2/`（.env 在这里，compose 用 `-f deploy/spark-radar-v2/docker-compose.yml`，相对 context 指向仓库根）
- 迁移数据：`/srv/apps/spark-radar-v2-migration/`（从旧 spark-radar 库只读导出的 github_star_snapshots.csv 47259 行、content_sources.csv 5 行）
- 旧栈：`/srv/apps/spark-radar/app` **不动**

## .env（服务器上生成，chmod 600，不入库不入聊天记录）

```
POSTGRES_PASSWORD=<openssl rand -hex 24>
SITE_URL=https://radar.yydsoh.com
ADMIN_PASSWORD=<openssl rand -base64 18，另存一份到 secrets/admin-password.txt>
SESSION_SECRET=<openssl rand -hex 32>
IMG_PROXY_SIGN_SECRET=<openssl rand -hex 32>
INGEST_TOKEN=<openssl rand -hex 24>
LLM_BASE_URL=http://cli-proxy-api:8317/v1
LLM_API_KEY=<复制自 /srv/apps/spark-radar/app/secrets/ai_api_key，服务端 cp，不经手内容>
LLM_MODEL=gemini-3.8-flash-high
COLLECT_ENABLED=true
MODEL_CALLS_ENABLED=true
```

## 步骤

1. 服务器 clone：`git clone https://github.com/ymolic/aihot.git /srv/apps/spark-radar-v2/repo && git -C ... checkout spark-fusion`
2. 生成 .env（上面的变量；密钥全部 openssl 生成，AI key 从旧栈 secrets 复制）。
3. `cd /srv/apps/spark-radar-v2/repo && docker compose -f deploy/spark-radar-v2/docker-compose.yml up -d --build`（setup 跑迁移+seed 后退出）。
4. 导入历史星标快照：
   `docker exec -i spark-radar-v2-db-1 psql -U aihot -d aihot -c "\copy spark_github_snapshots(repo,stars,forks,open_issues,observed_at) FROM STDIN WITH (FORMAT csv)" < /srv/apps/spark-radar-v2-migration/github_star_snapshots.csv`
   （列名以最终迁移文件为准。）
5. 启用采集源：跑模块的 seed（写入 spark_github_specs + sources 示范行），再把要开的源 enabled=true（participation_mode 必须是 editorial）。
6. 保守预算（花钱阀门）：检查 `budgets` 表每服务默认值，把 llm 的 per_hour/per_day 收紧到自用水平（引擎默认偏站点运营）。
7. 共享 Caddy（短暂中断，已获用户一次性授权）：
   - 备份 `/opt/obsidian-livesync/Caddyfile` 与 docker-compose.override.yml；
   - override 里给 Caddy 增加挂载 `/srv/apps/spark-radar-v2/repo/deploy/spark-radar-v2/caddy/spark-radar-v2.caddy:/etc/caddy/includes/spark-radar-v2.caddy:ro`；
   - `docker exec obsidian-livesync-caddy caddy validate --config /etc/caddy/Caddyfile` 通过后重建容器；
   - 验证其他站点（spark.yydsoh.com、api.yydsoh.com、n8n.yydsoh.com）仍 200。
8. 验收：`https://radar.yydsoh.com` 首页 200；`/api/health` 200；`/feed.xml` 有内容；`/api/mcp` 对 MCP 客户端可用（工具前缀 spark_）；次日 08:00 后 `/daily` 出刊。

## 前置条件 / 交接

- **DNS**：radar.yydsoh.com 需要 Cloudflare 上新增 proxied A 记录指向本机公网 IP（与 spark.yydsoh.com 同一来源）。无通配符记录（已验证），控制台手工加一条。DNS 未就绪前不要挂载站点块（ACME 会失败刷日志）。
- CLIProxyAPI 复用 spark-radar 的客户端 key（同一信任边界）；如需独立 key 在 CPA Manager Plus 里另发。

## 回滚

- 应用：`docker compose -f deploy/spark-radar-v2/docker-compose.yml down`（**不带 -v**；数据卷保留在 /srv/docker）。
- Caddy：还原 override 备份并重建容器即可；站点块独立文件，删除挂载即摘除。
- 全程不触碰旧 spark-radar 栈与共享 Caddy 的其他站点块。
