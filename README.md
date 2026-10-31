# AI超级面板 · AI-SuperPanel

**解决 agent 写完代码之后的「下一站」问题。** 现在 agent 能快速产出可用的 HTML 页面、JavaScript 小工具或 Python 脚本，但分享和使用一直很别扭——微信打不开 HTML 文件，跑 Python 要开终端、装依赖，折腾一圈别人还是用不上。本项目是自托管的 **AI 应用网关 + 门户**：agent 携带 `.asp-app` 打包规范（skill），按统一接口把成果直接发布上架——静态页面、前端工具、Python 应用（长驻服务）立刻获得访问地址、登录鉴权、统一主题与运行沙箱，他人点开即用、无需装任何环境；同时把散落在各端口的自部署应用（尤其 AI 应用）收敛到一个域名下——统一入口、自动 HTTPS、主题品牌、会员与 token 计费。**人从门户进来，应用经平台调用大模型。**

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
| `examples/hk-toast-recipe` | .asp-app HTML 包示例（纯前端：manifest.json + index.html，可直接上传门户安装） |
| `examples/ip-analyzer` | .asp-app Python 包示例（persistent 沙箱 + manifest.env 机密注入 + egress 白名单出站） |
| `examples/llm-proofread` | .asp-app Python 包示例（文语校对：规则引擎 + 逐段 LLM + 全文一致性，每用户提示词/词库落 aap.db，LLM 走统一网关按账号归因计费） |
| `deploy/` | Docker / FPK 分发形态 |
| `AGENTS.md` | AI 开发代理常驻约定（硬纪律 / 按需加载 / 交互约定） |
| `docs/DEVELOPMENT.md` | 开发者文档（架构 / 配置 / LLM 网关接入 / 通知通道 / 订阅计费） |
| `docs/` | 产品需求与规范（PRD / app-develop 技能） |

## 开发

```bash
pnpm install
pnpm dev          # server: http://localhost:8080 · web: http://localhost:5173
pnpm test          # 单元/集成测试（服务端 17 个文件 195 用例）
pnpm test:e2e     # Playwright 端到端（自动起真实服务 + mock 上游）
pnpm typecheck    # 全部类型检查
```

要求 Node ≥ 22。开发服务器与服务端测试均要求可访问的 PostgreSQL；通过 `DATABASE_URL`（测试可用 `TEST_DATABASE_URL`）指定连接串。测试为每个测试文件创建并删除独立 schema，因此数据库用户需要 `CREATE SCHEMA` 权限。

Docker 部署默认包含 PostgreSQL：

```bash
cd deploy/docker
cp .env.example .env       # 修改 POSTGRES_PASSWORD，使用长随机字母数字密码
docker compose up -d --build
```

PostgreSQL 数据保存在 `postgres-data` 卷，门户文件（证书、密钥、应用包等）保存在 `../../data`。全新部署会自动应用 `drizzle-pg/` 中的迁移；本次切换不导入旧 SQLite 数据。

原生运行包与飞牛 FPK 不内置数据库服务，需另行提供 PostgreSQL 17 并配置 `DATABASE_URL`（FPK 由安装向导收集连接串）。平台业务数据统一存于 PostgreSQL；托管应用可使用各自独立的 `app.sqlite` 保存应用自身状态。


## 核心能力（当前实现）

- **应用网关**：`/app/<id>/` 路径反代（HTML 改写 / `<base>` / fetch+XHR+script 猴补丁 / 路径穿越防御 / SSE 零缓冲），**WebSocket 透传**（HTTP+HTTPS 双通道），passUser 签名身份注入（X-AAP-Identity）
- **门户托管应用**：简单 HTML 页直接粘贴接入；上传 `.asp-app` 包自动校验 manifest 并提取字段；包上传即自动签发网关凭据（加密保管，运行时注入；未声明 `llm` 能力的包凭据仅用于出站代理，LLM 调用在网关侧按能力声明闸拒绝）；manifest `env` 声明环境变量/机密（必填/可选/格式校验/默认值），归属者或管理员在门户填值、密钥加密存储（只写不读），沙箱启动时注入进程环境变量；个人中心应用管理按需加载应用列表，并在加载失败时提供错误详情与重试
- **LLM 网关**：OpenAI 兼容 `/v1/chat/completions`（流式）+ `/v1/models`；多上游按优先级+权重 failover；网关凭据（SHA-256 存储/可吊销/限流），**能力声明闸**对 `/v1` 直连与沙箱代理双侧强制（manifest 未声明 `llm` 一并 403）；用户级+应用级计量（append-only 账本）、余额预检 402、预估事后校正；沙箱调用支持平台默认模型与生成上限（`LLM_DEFAULT_MODEL` / `LLM_SANDBOX_MAX_TOKENS`，0=不限）、上游连通性一键测试；**无归因调用默认拒绝**（`LLM_UNATTRIBUTED_POLICY` 可放行）
- **门户首页**：首页品牌文案由站点设置中的站点名称动态显示，首屏欢迎语与搜索居中展示；显示页眉的页面均使用透明毛玻璃效果；页眉支持「浏览应用」、权益、FAQ 快速定位，导航与用户入口留有清晰间距；「现在开始」进入按一至五分章、紧凑排版的应用制作导航，完成或跳过后进入登录/注册，已登录用户可直接开始管理应用；登录/注册采用图文分栏布局，提供服务条款与可接受使用政策
- **账号与安全**：本地账号+注册（验证码 SMTP/Resend/日志兜底、邀请码事务化防双花、Turnstile）、注册时自动分配预置头像并按策略赠送初始积分、初始管理员获得 99,999,999 积分、普通新用户在有可用权益包时选择套餐（零价立即生效、积分足额即时兑换、人民币/美元创建人工确认订单；无可用套餐时以未订阅状态进入个人中心）、右上角头像昵称入口展示当前实际权益及等级图标、账号资料与浅色/深色/跟随系统选择（通过浏览器 cookie 保持选择，仅影响个人中心和「我的应用」）、导航直达个人中心和独立「我的应用」卡片墙、登录后进入个人中心、MFA（TOTP+Passkey，绑定新因子需步升）、OIDC 单点登录（PKCE）、登录防爆破（IP+账号双维度）+IP 封禁累犯倍增+PoW、步升认证（登录即授窗口）、审计日志、敏感配置 AES-GCM 落盘、HTTPS 启用即挂 HSTS
- **订阅与计费**：个人中心「我的权益」（当前权益、可选择权益包与兑换码）、人民币/美元/积分三种套餐计价（人民币和美元沿用人工确认，积分与 LLM Token 独立并在事务内扣减、立即开通）、注册赠分策略、等级 0–5 套餐配置及等级图标、账单式订阅下单、可配置显示的额度充值和订单卡片、运营面板（套餐/订单/卡券码/排行/成本毛利）
- **可见性模型**：公开 / 需登录 / 指定分组与账号 / 仅自己（用户自建应用默认私有，门户对他人隐藏）
- **统一页面元素**：所有托管/代理应用右上角自动注入「返回超级面板」悬浮入口（portal-chrome.js，幂等失败静默），覆盖 HTML 托管、persistent 反代直连与沙箱外壳层三条通道

## 里程碑

- **M1 门户可用** ✅：路径反代（HTTP+WS/SSE）、自动 HTTPS、本地账号+注册、MFA、用户中心、管理后台、Docker/FPK 分发
- **M2 LLM 网关** ✅：OpenAI 兼容端点（含流式）、多上游路由与 failover、网关凭据、用户级+应用级计量与预检、OIDC SSO
- **M3 计费闭环** ✅：功能订阅×分组可见性、额度充值与卡券码、结算对账+到期降级、运营面板
- **M4 生态** ◐：Python 沙箱运行时（invoked 全链路 + persistent 拉起/回收/重启 + **HTTP/WS 反代透传**）、`.asp-app` 上传无需签名，用户上传后默认私有并可按订阅名额自行发布公开应用（无管理员审核）、**用户包 iframe 沙箱（PRD G1：opaque origin，禁同源 cookie 面）**、统一页面元素注入（沙箱外壳层）；**沙箱内 LLM 调用已闭环归因到调用者**（环境/请求身份 → 平台代理验签 → 网关预检扣费）。剩 aap-dev 完整版。**沙箱隔离现状**：SDK 出网的受控通道为平台 egress 代理（manifest 白名单 + **解析后 IP 私网段复核**逐跳校验），runner 内置 Python 层出站守卫（直连仅放行平台地址，`AAP_NET_GUARD=0` 关闭），容器内可设 `SANDBOX_UID/GID` 降权运行（compose 已注记推荐开启）；进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离待补

详见 `docs/ai-app-portal-PRD-v0.3.1.md`；开发者文档见 `docs/DEVELOPMENT.md`。

## 许可证

[GPL-3.0](LICENSE) —— 本项目按 **GNU General Public License v3.0** 开源：你可以自由使用、修改和分发，衍生作品在分发时必须同样以 GPL-3.0 开源。版权所有 © 2026 neon9809。
