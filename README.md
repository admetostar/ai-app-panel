# AI超级面板 · AI-SuperPanel

**将 AI Agent 创建的应用从代码成果变成可访问、可管理、可运营的服务。** AI 超级面板是一套自托管的 AI 应用门户与运行平台：Agent 可按 AWPK 规范打包应用，用户上传后即可安装和发布 HTML、前端工具及 Python 应用；平台提供统一访问入口、应用可见范围与登录控制，并通过沙箱运行 Python 应用。对于已有服务，也可通过应用网关统一接入。平台还内置 OpenAI 兼容的 LLM 网关，支持多上游路由、应用与用户用量归因，以及会员、积分和 Token 额度管理，帮助个人或团队在自有环境中部署、分享并运营 AI 应用。

```
用户 ──HTTPS──▶ AI-SuperPanel（自动证书，监听端口）
                  ├─ 门户 UI ──▶ 应用卡片墙 / 主题 / 品牌 / 备案
                  ├─ 用户中心 ──▶ 个人信息 / 财务 / 安全 / 注销
                  ├─ 应用网关 ──▶ 路径反代 ──▶ 127.0.0.1:8001 (app A)
                  │             ──▶ 127.0.0.1:8002 (app B)   [HTTP + WS/SSE]
                  ├─ LLM 网关 ──▶ OpenAI 兼容中转 ──▶ 阿里云/智谱/火山/vLLM…
                  └─ 计费 ──▶ 会员×应用可见性 + token 额度池
```

## 仓库结构

| 目录 | 说明 |
|---|---|
| `apps/server` | 服务端：Express 4 + TypeScript + Drizzle ORM + PostgreSQL |
| `apps/web` | 前端：React 18 + Vite + TS + Ant Design 5（门户 / 用户中心 / 管理后台三合一 SPA） |
| `packages/shared` | 前后端共享类型与 API 契约 |
| `packages/aap-sdk` | Python：`aap` 运行时存根 + `aap-dev` 本地调试沙箱（M4 实装） |
| `examples/hk-toast-recipe` | AWPK HTML 应用示例（纯前端：manifest.json + index.html，可直接上传门户安装） |
| `examples/ip-analyzer` | AWPK Python 应用示例（persistent 沙箱 + manifest.env 机密注入 + egress 白名单出站） |
| `examples/llm-proofread` | AWPK Python 应用示例（文语校对：规则引擎 + 逐段 LLM + 全文一致性，每用户提示词/词库落 aap.db，LLM 走统一网关按账号归因计费） |
| `deploy/` | Docker / FPK 分发形态 |
| `AGENTS.md` | AI 开发代理常驻约定（硬纪律 / 按需加载 / 交互约定） |
| `docs/DEVELOPMENT.md` | 开发者文档（架构 / 配置 / LLM 网关接入 / 通知通道 / 订阅计费） |
| `docs/` | 产品需求与规范（PRD / app-develop 技能） |

## 开发

```bash
pnpm install
pnpm dev          # server: http://localhost:8080 · web: http://localhost:5173
pnpm skills:sync  # 生成 AWPK .skill/.zip/.md 并同步到 apps/server/assets
pnpm build        # 自动同步 skill 后构建
pnpm test          # 单元/集成测试（服务端 21 个测试文件 219 个用例）
pnpm test:e2e     # Playwright 端到端（自动起真实服务 + mock 上游）
pnpm typecheck    # 全部类型检查
```

要求 Node ≥ 22。开发服务器与服务端测试均要求可访问的 PostgreSQL；通过 `DATABASE_URL`（测试可用 `TEST_DATABASE_URL`）指定连接串。测试为每个测试文件创建并删除独立 schema，因此数据库用户需要 `CREATE SCHEMA` 权限。

AWPK Agent skill 的源文件是 `docs/app-develop.skill-v0.3.md`。修改后执行 `pnpm skills:sync`，生成 `.skill`、`.zip` 和 `.md` 三种下载格式并同步到 `apps/server/assets`，供「操作导航」下载；压缩包内的 `SKILL.md` 位于 ZIP 根目录，避免部分 Agent 无法识别。

本地账号新密码需为 8-128 位，并至少包含大写字母、小写字母和数字；注册、找回密码、修改密码及管理员手动设置初始密码均执行此规则。

Docker 部署默认包含 PostgreSQL：

```bash
cd deploy/docker
cp .env.example .env       # 修改 POSTGRES_PASSWORD，使用长随机字母数字密码
docker compose up -d --build
```

PostgreSQL 数据保存在 `postgres-data` 卷，门户文件（证书、密钥、应用包、站点 Logo 等）保存在 Docker 命名卷 `ai-superpanel-data`；Logo 图片写入 `/data/admin/site-logo/`，其 `/uploads/sitelogo/...` 地址由服务端映射提供，不需要单独挂载 `/uploads`。从旧版 `../../data` bind mount 升级时，命名卷不会自动包含旧文件；请按 [Docker 数据卷迁移说明](./docs/DEVELOPMENT.md#docker-compose-数据卷迁移)先复制数据再重建门户容器。全新部署会自动应用 `drizzle-pg/` 中的迁移；本次切换不导入旧 SQLite 数据。

原生运行包与飞牛 FPK 不内置数据库服务，需另行提供 PostgreSQL 17 并配置 `DATABASE_URL`（FPK 由安装向导收集连接串）。平台业务数据统一存于 PostgreSQL；托管应用可使用各自独立的 `app.sqlite` 保存应用自身状态。

“我的应用”分为“我自己的”和“已共享的”；已共享列表只显示其他用户或平台公开、或设置为需登录的应用，不显示仅自己可见的应用。

个人中心「应用管理」中的已创建应用支持点击名称查看双列详情，点击「设置」可上传持久化到应用私有目录的图标、编辑名称/描述/可见范围，并在同一弹窗配置环境变量；唯一的「保存设置」按钮会一并保存基础设置和环境变量；删除操作保留独立按钮。


## 核心能力（当前实现）

- **个人中心 Dashboard**：固定可折叠左侧导航，按「应用」「账户和安全」「权益中心」分组提供六个二级入口，导航项悬浮时有高亮反馈；浅色主题下内容、侧栏和卡片均使用白色背景，深色主题下各板块、表格分页和弹窗统一使用深色调；已创建应用列表紧凑显示，每页十项且不出现横向滚动条；隐藏门户页眉，品牌与用户入口分别置于侧栏顶部和底部，每次只展示一个带标题和说明的内容面板。
- **全站字体**：门户、认证页、操作导航、个人中心及管理后台统一使用系统无衬线字体；代码与密钥等需要对齐的内容保留等宽字体。

- **应用网关**：配置「本站域名」后，应用使用 `<应用 ID>.<本站域名>` 独立 origin，可使用自己的 localStorage 和 Cookie；未配置域名时所有应用使用门户同源入口（用户上传应用仍由 opaque-origin iframe 沙箱隔离，不暴露服务端内部端口）。平台会话 Cookie 不转发给应用、应用 Cookie 限定为当前主机；HTTP 下将应用 Cookie 的 `SameSite=None` 调整为 `Lax`，HTTPS 下保留 `SameSite=None` 并添加 `Secure`。生产需配置通配 DNS 与 `*.<本站域名>` 证书（当前 ACME HTTP-01 不签通配证书）。路径反代仍支持上游应用（HTML 改写 / `<base>` / fetch+XHR+script 猴补丁 / 路径穿越防御 / SSE 零缓冲）；管理员可在应用管理查看进程生命周期、HTTP 错误/超时和慢请求运行事件（不记录请求正文或凭据）；**WebSocket 透传**（HTTP+HTTPS 双通道），passUser 签名身份注入（X-AAP-Identity）
- **门户托管应用**：简单 HTML 页直接粘贴接入；上传 AWPK（ZIP 容器，必须 `.awpk` 扩展名，包含 `manifest.json`）后自动校验并安装；不接受旧 `.asp-app` 或通用 `.zip` 文件。包上传即自动签发网关凭据（加密保管，运行时注入；未声明 `llm` 能力的包凭据仅用于出站代理，LLM 调用在网关侧按能力声明闸拒绝）；manifest `env` 声明环境变量/机密（每包最多 16 项、值最多 8,192 字符），归属者或管理员在门户填值、密钥加密存储（只写不读），沙箱启动时注入进程环境变量。Python 包通过 `aap.*` 使用隔离 SQLite、默认 10 MiB 文件存储和仅 GET 的白名单 HTTP 代理；当前没有 per-app CPU/内存硬限额或 SQLite 硬配额，能力清单、准确限制与 Agent 禁止事项见 [`docs/app-develop.skill-v0.3.md`](docs/app-develop.skill-v0.3.md)；个人中心应用列表按列显示安装日期、包大小、版本和平台支持，并提供图标化设置/删除操作，环境变量弹窗与个人中心主题保持一致
- **应用数量权益**：权益套餐限制用户可上传的托管应用总数（含私有和公开应用）；同名更新不额外占用名额。公开发布不受应用数量限制。
- **公开发布积分奖励**：后台可为每个用户分组设置公开发布奖励；用户首次公开自己的应用时按所属分组获得一次积分，删除已获奖励的应用时扣回（余额最低为 0），重复发布不会重复获得奖励。
- **LLM 网关**：OpenAI 兼容 `/v1/chat/completions`（流式）+ `/v1/models`；多上游按优先级+权重 failover；网关凭据（SHA-256 存储/可吊销/限流），**能力声明闸**对 `/v1` 直连与沙箱代理双侧强制（manifest 未声明 `llm` 一并 403）；用户级+应用级计量（append-only 账本）、余额预检 402、预估事后校正；沙箱调用支持平台默认模型与生成上限（`LLM_DEFAULT_MODEL` / `LLM_SANDBOX_MAX_TOKENS`，0=不限）、上游连通性一键测试；**无归因调用默认拒绝**（`LLM_UNATTRIBUTED_POLICY` 可放行）
- **门户首页**：首页品牌文案由站点设置中的站点名称动态显示，首屏欢迎语与搜索居中展示；首页页眉固定在顶部，未滚动时完全透明并使用灰白导航文字、白底黑字登录按钮，滚动后切换为毛玻璃乳白半透明背景、灰黑导航文字和黑底白字登录按钮；「发现应用」、权益、FAQ 与登录按钮使用等间距排列；其它显示门户页眉的页面保持磨砂透明背景；「现在开始」进入按一至五分章、紧凑排版的应用制作导航，完成或跳过后进入登录/注册，已登录用户可直接开始管理应用；登录/注册采用图文分栏布局，提供服务条款与可接受使用政策
- **站点品牌设置**：后台站点设置可直接上传 PNG/JPEG/GIF/WebP Logo（最大 5 MB），图片持久化到数据卷 `admin/site-logo` 目录；保存后站点名称同步更新浏览器页面标题，Logo 同步显示为浏览器标签页图标及门户品牌
- **账号与安全**：本地账号+注册（验证码 SMTP/Resend/日志兜底、邀请码事务化防双花、Turnstile）、注册时自动分配预置头像并按策略赠送初始积分、初始管理员获得 99,999,999 积分、普通新用户在有可用权益包时选择套餐（零价立即生效、积分足额即时兑换、人民币/美元创建人工确认订单；无可用套餐时以未订阅状态进入个人中心）、右上角头像昵称入口展示当前实际权益及等级图标、账号资料与浅色/深色/跟随系统选择（通过浏览器 cookie 保持选择，仅影响个人中心和「我的应用」）、导航直达个人中心和独立「我的应用」卡片墙、登录后进入个人中心、MFA（TOTP+Passkey，绑定新因子需步升）、OIDC 单点登录（PKCE）、登录防爆破（IP+账号双维度）+IP 封禁累犯倍增+PoW、步升认证（登录即授窗口）、审计日志、敏感配置 AES-GCM 落盘、HTTPS 启用即挂 HSTS
- **订阅与计费**：个人中心「我的权益」展示权益用途、实际额度与历史订阅；「获取权益」支持查看方案、积分兑换及兑换码获取；人民币/美元/积分三种套餐计价（人民币和美元沿用人工确认，积分与 LLM Token 独立并在事务内扣减、立即开通）；更高等级权益订阅后立即生效，同等级订阅从当前权益到期时间顺延，较低等级须等当前权益到期后才能订阅；订阅账单可按套餐展示管理员配置的外部兑换码链接、注册赠分策略、等级 0–5 套餐配置及等级图标、可配置的 Token 额度获取与运营面板（套餐/订单/卡券码/排行/成本毛利）；卡券批次和列表查询兼容 PostgreSQL 分组与主键排序规则
- **可见性模型**：公开 / 需登录 / 指定分组与账号 / 仅自己（用户自建应用默认私有，门户对他人隐藏）
- **统一页面元素**：兼容路径模式下的托管/代理应用可注入右下角站点名称入口（名称使用后台站点配置）；独立应用 origin 不注入门户页面脚本，避免把门户功能暴露给用户应用

## 里程碑

- **M1 门户可用** ✅：路径反代（HTTP+WS/SSE）、自动 HTTPS、本地账号+注册、MFA、用户中心、管理后台、Docker/FPK 分发
- **M2 LLM 网关** ✅：OpenAI 兼容端点（含流式）、多上游路由与 failover、网关凭据、用户级+应用级计量与预检、OIDC SSO
- **M3 计费闭环** ✅：功能订阅×分组可见性、额度充值与卡券码、结算对账+到期降级、运营面板
- **M4 生态** ◐：Python 沙箱运行时（invoked 全链路 + persistent 拉起/回收/重启 + **HTTP/WS 反代透传**）、`.awpk` 上传无需签名，用户上传后默认私有并可按订阅名额自行发布公开应用（无管理员审核）、用户应用独立子域名及浏览器原生会话存储、**沙箱内 LLM 调用闭环归因**（环境/请求身份 → 平台代理验签 → 网关预检扣费）。剩 aap-dev 完整版。**沙箱隔离现状**：SDK 出网的受控通道为平台 egress 代理（manifest 白名单 + **解析后 IP 私网段复核**逐跳校验），runner 内置 Python 层出站守卫（直连仅放行平台地址，`AAP_NET_GUARD=0` 关闭），容器内可设 `SANDBOX_UID/GID` 降权运行（compose 已注记推荐开启）；进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离待补

详见 `docs/ai-app-portal-PRD-v0.3.1.md`；开发者文档见 `docs/DEVELOPMENT.md`。

## 许可证

[GPL-3.0](LICENSE) —— 本项目按 **GNU General Public License v3.0** 开源：你可以自由使用、修改和分发，衍生作品在分发时必须同样以 GPL-3.0 开源。版权所有 © 2026 neon9809。
