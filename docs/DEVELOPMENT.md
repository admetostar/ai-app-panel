# 开发者文档（DEVELOPMENT）

> 面向本仓库的开发者。产品需求见 `./ai-app-panel-PRD-v0.3.1.md`，
> AWPK 应用开发规范见 `./app-develop.skill-v0.3.md`。

## 1. 架构总览

```
用户 ──HTTPS──▶ ai-app-panel（Express 4 + TS，端口 8080/8443）
                  ├─ 门户 SPA（React 18 + Vite，生产由 server 托管 / 开发走 Vite 5173 代理）
                  ├─ 应用网关 <id>.<本站域名>/（未配置域名时走同源 /app/<id>/）及兼容入口
                  │        └─▶ 反代上游（Dify/Streamlit…）或托管 HTML / Python 应用
                  │        └─ WS upgrade / SSE 零缓冲 / passUser 身份注入（X-AAP-Identity）
                  ├─ LLM 网关 /v1/* ──▶ 多上游 failover ──▶ OpenAI 兼容上游（智谱/阿里/vLLM…）
                  ├─ 账号/订阅/计费/卡券码/运营（PostgreSQL + Drizzle）
                  └─ 通知通道（SMTP / Resend / 日志兜底）
```

- 单进程单机语义：WS 会话、LLM 挑战、限流桶均在进程内；关系型数据（含账号、会话、计费与配置）保存在 PostgreSQL，证书/密钥文件/托管应用/应用包在 `DATA_DIR`（默认 `apps/server/data`，Docker 为 `/data`）。
- 前后端契约单一来源：`packages/shared`（类型 + 常量）。

## 2. 开发命令

```bash
pnpm install
pnpm dev            # server:8080（tsx watch）+ web:5173（Vite，代理 /api 与 /app）
pnpm skills:sync    # 从 Markdown 更新 .skill/.zip 包并同步三种下载格式到 apps/server/assets
pnpm build          # 先同步 skill，再构建 shared → server → web（生产产物 apps/web/dist）
pnpm test           # 服务端测试（vitest，23 个文件 224 个用例）
pnpm test:e2e       # Playwright 端到端（自动拉起真实服务 + mock 上游）
pnpm typecheck      # 全仓类型检查
pnpm db:generate    # drizzle-kit 生成迁移（schema 变更后必跑）
```

要求 Node ≥ 22。开发服务器、服务端测试与 E2E 均使用 PostgreSQL。设置 `DATABASE_URL` 后运行 `pnpm dev`；服务端测试可单独设置 `TEST_DATABASE_URL`，E2E 可单独设置 `E2E_DATABASE_URL`，均需使用有创建 schema 权限的数据库账号。`setupTestDb()` 为每个服务端测试文件创建独立 schema、应用 `apps/server/drizzle-pg` 初始迁移，并在结束后删除 schema；Playwright E2E 同样创建专用 schema，运行结束后删除，不再直接读取或修改 SQLite 文件。当前迁移目录仅维护 PostgreSQL 基线；旧数据库、旧迁移历史和旧业务数据不兼容、不导入。请始终为新部署提供空数据库 `ai_app_panel`。Docker Compose 自带 PostgreSQL 17；原生与 FPK 部署需自行创建空数据库并设置连接串。托管应用自行创建的 `app.sqlite` 是应用级状态库，不是门户业务数据库。

门户首页首屏背景图源文件位于 `apps/server/assets/home-background.png`，由 Vite 从 `apps/web/src/global.css` 打包；首页背景卡片、页眉、内容区与页脚共用约 1130px 的内容宽度。首屏主按钮未登录进入 `/login`、已登录进入 `/account`，操作指南按钮进入 `/guide`；应用搜索框位于应用列表区域。

AWPK Agent skill 的权威 Markdown 为 `docs/app-develop.skill-v0.3.md`。更新该文件后运行 `pnpm skills:sync`（`pnpm build`、Docker、原生包和 FPK 构建也会自动同步）：它生成 `.skill` 与 `.zip` 两种 ZIP 格式和 `awpk-app-develop.md`，并将三种下载文件复制到 `apps/server/assets`，供「操作导航」下载。压缩包内 `SKILL.md` 必须位于 ZIP 根目录，不能再包一层 `awpk-app-develop/` 目录。

本地账号的新密码策略由 `packages/shared` 的 `isPasswordValid` 单一维护：8-128 位，至少包含大写字母、小写字母和数字。服务端在注册、找回密码、修改密码、管理员创建用户和密码重置时校验；前端对应表单同步提示与校验。管理员自动生成的初始密码由随机字母数字组成并符合此策略。

Docker Compose 默认启动 PostgreSQL 17 和门户。复制 `deploy/docker/.env.example` 为 `.env` 并设置强 `POSTGRES_PASSWORD`，然后在 `deploy/docker` 运行 `docker compose up -d --build`。新项目使用 `ai-app-panel-postgres-data` 数据卷和 `ai-app-panel-data` 文件卷；门户会等数据库健康检查通过后启动，并自动应用 `drizzle-pg/` 中的 PostgreSQL 初始迁移。旧项目的 Docker 卷、数据库、表和文件均不迁移；Compose 使用新的项目、容器和卷名称，不会自动删除或导入旧卷。不要将旧项目数据库连接串用于新部署。

`DATABASE_URL` 是唯一运行时数据库连接配置，`MIGRATIONS_DIR` 可覆盖迁移目录（Docker 镜像中为 `/out/drizzle-pg`）。schema 有变更时运行 `pnpm db:generate`，生成的 PostgreSQL 迁移必须与 schema 一起提交。初始基线由 `src/db/schema.ts` 生成，外键引用保持基于 `search_path` 的未限定表名，以便测试在隔离 schema 中应用同一份迁移。

## 3. 配置体系（两层）

1. **env（`apps/server/src/config`）**：端口、路径、一次性初值（如 `ADMIN_INITIAL_PASSWORD`、`TRUST_PROXY`）。启动读一次。
2. **settings 表（`lib/settings.ts` 的 `SETTING_DEFS`）**：运行时可调策略。首启用 `initial()`（通常取 env）做种子；管理后台改值即时生效。每项有 `group`（管理面板分组）/ `secret`（只写不读，回显 `********`）/ `advanced`（高级项折叠）/ `defaultsWork`（「默认值即可跑」标注）。

密钥查看：secret 型默认不可读；`GET /api/admin/secrets/:key` 可查看（记审计），管理界面同路径有「查看」按钮——自研应用接入验签（`AAP_SIGN_SECRET`）从这里取。passUser 应用免手动取值：勾选「注入用户身份」的 .aap 包沙箱自动注入 `AAP_SIGN_SECRET`（baseEnv）；上游应用在管理后台应用表单勾选 passUser 时直接显示复制。后台轮换密钥（stopAllPersistent）或切换 passUser 开关（stopPersistentFor）自动停起 persistent 进程，下次访问以新配置拉起。

主要分组：站点与品牌 / 注册与账号 / 人机验证 / 通知通道（验证码发信：SMTP 或 Resend）/ 证书与 HTTPS / 安全与限流 / 应用网关 / 计费。

管理端渲染约定（`apps/web/src/pages/Admin.tsx`）：
- 每项按元数据选控件：`choiceLabels` → 下拉（中文选项）、bool → 开关、`secret` → 密码框 + 「查看」（`GET /api/admin/secrets/:key`，记审计）、int → 数字框
- `exclusiveOf` 互斥渲染：如 `MAIL_PROVIDER=resend` 时只显示 Resend 两项、隐藏 SMTP 五项
- 展示降噪：短标签 + 悬浮详情（完整描述与配置键）；仅 `defaultsWork=false` 的项显示「需配置」橙标
- 「通知通道」「计费」「证书(HTTPS 跳转)」等有专用面板，经 `excludeKeys` 排除由专用表单写入的键

管理员页面复用个人中心的主题与可折叠左侧导航，站点、应用、用户、安全、通知、证书、LLM 和运营设置均由侧栏进入，不再显示首次配置向导或顶部标签栏。管理页按当前主题单独配置 Ant Design 组件算法；深色模式下表单、选择器及弹出列表、表格、卡片、提示和文字均切换到高对比度深色配色。`GET /api/admin/overview` 为总览提供 CPU/内存水位、网络收发速率、用户与应用累计数、近 30 天 Token 消耗以及按套餐分组的有效订阅数量。CPU 使用进程内采样，首次采样显示采集中；内存使用主机总量/空闲量；网络带宽通过 Linux `/proc/net/dev` 的接口收发字节差计算，并以 10 Mbps 为水位基准，非 Linux 或计数器不可读时明确显示不可用。无固定上限的用户、应用和 Token 累计数使用数量级映射进度条，不代表权益上限。

站点设置的 Logo 可通过输入框后的「上传」按钮选择 PNG/JPEG/GIF/WebP 图片（最大 5 MB）；文件写入 `DATA_DIR/admin/site-logo/`，服务端返回的 `/uploads/sitelogo/<随机文件名>` 路径回填到设置框，保存设置后应用到门户品牌和浏览器标签页图标；站点名称同步作为浏览器页面标题。页脚文案、版权声明、ICP备案号及公安备案号均可在站点设置中配置；版权声明留空时默认显示当前年份与站点名称，首页页脚内容居中对齐。平台会话 Cookie 默认不设置 `Domain`，按当前访问主机建立 host-only 会话；只有配置「本站域名」时才设置 Cookie 域名。Docker Compose 将整个 `/data` 挂载到 `ai-app-panel-data` 命名卷，因此该目录会在容器重建后保留。

证书管理通过 Cloudflare DNS-01 自动签发根域名及 `*.<根域名>` 通配符证书，并自动清理验证 TXT 记录。签发步骤和当前证书详情显示在管理后台「证书」页；证书详情包括颁发者、覆盖域名、生效/到期时间、剩余天数和指纹，Staging 测试证书会明确标记为浏览器不信任。后台签发固定使用 Let's Encrypt 正式环境；手动 PEM 安装作为高级选项保留。Cloudflare 配置位于管理后台「证书」→「Cloudflare DNS-01 配置」：填写 Zone ID 和仅对此 Zone 授予 DNS:Edit 权限的 API Token；Token 使用 settings secret 加密保存，签发状态与审计记录不包含 Token。DNS-01 配置会用于自动续期。ACME HTTPS 请求优先使用 IPv4，以兼容没有 IPv6 出站路由的服务器；服务器还需能解析并通过 HTTPS 访问 ACME 服务。签发失败会在状态页与容器日志中显示失败阶段及嵌套网络原因（例如连接超时及错误码），便于区分 Cloudflare/ACME 连通性、DNS 和 TLS 故障；API Token 不写入错误信息。

## 4. 应用网关（/app/\<id\>/）

- **独立应用 origin**：配置「站点设置 → 本站域名」后，应用通过 `<应用 ID>.<本站域名>` 提供服务；留空时卡片和旧 `/app/<id>/...` 入口使用门户同源路径，不把内部服务端口暴露给浏览器。此本地回退仍通过 opaque-origin iframe 隔离用户上传应用；需要验证独立 origin / 浏览器存储时应配置应用域名。配置域名后，公开且需经沙箱的应用从旧 `/app/<id>/...` 入口访问时会跳转至应用子域名。应用子域名上的 `/api`、`/v1` 都只属于该应用，不进入门户接口；缺失或空 Host 不视为应用子域名并安全回落到门户路由。代理只移除平台会话 Cookie，应用 Cookie 会去掉 `Domain` 并限制为当前主机，不允许覆盖平台会话 Cookie；HTTP 下将 `SameSite=None` 调整为 `Lax`，避免浏览器拒收缺少 `Secure` 的 Cookie，HTTPS 下保留 `SameSite=None` 并加 `Secure`。请求的 `Origin`/`Referer` 透传给应用，以保留应用自己的 CSRF 校验能力。
- **部署要求**：生产环境需将 `*.<本站域名>` DNS 指向本服务，并部署包含 `*.<本站域名>` 的通配证书；证书管理通过 Cloudflare DNS-01 签发通配符证书。应用可按普通网站使用 `localStorage` 与 host-only Cookie，页面刷新后由浏览器按各自 origin 保持状态。
- 应用注册在 `apps` 表（管理后台 → 应用管理），三种形态 `kind`：
  - `upstream`：反代到内网上游（HTML 改写 + `<base>` + fetch/XHR/script 猴补丁 + 路径穿越双查 + `duplex:'half'` + SSE 零缓冲）
  - `html`：门户托管静态页（`DATA_DIR/appsites/<id>/`），支持简单 HTML 粘贴接入与 .awpk html 包
  - `package`：.awpk Python 包。更新同一应用时包作者必须递增 `manifest.version`（至少 PATCH，未知当前值先询问）；平台上传接口不会自动递增或拒绝重复版本。`invoked` 经「统一执行入口」`POST /api/apps/:id/run` 拉起一次性进程运行；`persistent` 首次访问应用域名或 `/app/<id>/` 时由平台拉起长驻进程并反代（HTTP 与 WebSocket 同通道，同一套门禁/限流；空闲回收 `SANDBOX_IDLE_RECYCLE_SECONDS` 默认 300s 可调、崩溃自动重启上限 3 次、并发执行上限 `SANDBOX_MAX_CONCURRENT_RUNS`、全局进程数上限 `SANDBOX_MAX_PERSISTENT`（默认 12，超限回收最久未用进程腾位））。兼容路径反代转发前剥 `/app/<id>` 前缀（包路由挂根），前缀经 `x-forwarded-prefix` 下发、站内相对 `Location` 镜像回写；`/open/<id>` 保留为兼容重定向页。
- 管理后台「应用管理」通过 `GET /api/admin/apps` 获取完整应用字段；门户应用列表通过 `GET /api/apps` 获取当前用户可见应用。个人中心「应用管理」仅在该分区激活时请求 `GET /api/apps/mine`，并展示加载状态、错误详情与重试入口；已创建应用列表以独立列展示安装日期、上传包大小、版本和平台支持，平台支持用图标标识数据库、大模型、网络白名单与存储能力；设置/删除使用图标按钮，环境变量弹窗沿用个人中心主题。声明了 `MODEL`、`OCR_MODEL`、`MODEL_NAME` 等模型变量的应用，在环境变量 GET 响应中附带启用模型目录，弹窗以可搜索的单一下拉框供归属者或管理员选择，不显示模型变量专属描述。新 LLM 应用按作者规范统一声明必填 `MODEL`。
- 管理后台「应用管理」还可查最近 200 条应用运行事件（按应用/级别筛选，30 秒刷新）；记录 persistent 进程启动/就绪/退出/重启/回收、HTTP 错误与超时，以及耗时 ≥1 秒的请求。代理请求等待上限为 `min(PROXY_TIMEOUT, 25s)`，超时返回 504。事件仅包含路径（剥除 query）、方法、状态、耗时、用户 ID 与受限诊断详情，不保存请求/响应正文、Cookie 或认证凭据；按“审计保留（天）”设置清理。
- **iframe 沙箱兼容**：配置应用域名时，用户应用从独立 origin 进入，不依赖 opaque-origin iframe；未配置时通过同源门户路径和 opaque-origin iframe 沙箱运行。`/app/<id>/raw/...` 仅在已配置应用域名时跳转至新域名下去掉 `/raw` 标记后的等价路径。
- **AWPK 包格式与开发边界**：应用开发 Agent 应遵循 [`app-develop.skill-v0.3.md`](./app-develop.skill-v0.3.md) 的清单与资源表。AWPK 是含 `manifest.json` 的 ZIP 容器，只接受 `.awpk` 扩展名，不兼容 `.asp-app` 或 `.zip` 上传。当前仅 `llm` 声明由服务端强制门控，`db`/`storage` 尚无逐项运行时闸；storage 默认 10 MiB/应用，SQLite 无硬容量配额；CPU/内存无 per-app 硬限额。出站仅可经 `aap.http.fetch`（HTTP(S) GET、manifest 白名单、逐跳 DNS/IP 检查），Python 网络守卫不是硬隔离。
- 配置应用域名并使用独立 origin 后，应用自己的网页登录态可使用该 origin 的 localStorage/sessionStorage 与 host-only Cookie；未配置时的同源 iframe 沙箱回退不提供这些存储能力。平台会话 Cookie 不转发。公开应用若需要独立账号体系，必须自行认证并隔离用户数据，不能假设访客拥有平台账号或身份头。
- **应用数量权益**：订阅套餐分别配置“可创建应用”和“可克隆应用数”。创建额度只统计用户直接上传的托管应用；站内共享克隆只占克隆额度、不重复占创建额度。克隆事务锁定用户并校验当前有效权益与已持有克隆数，复制托管应用文件和加密环境变量，清除应用运行期 `app.sqlite`/`storage` 数据，强制副本为仅自己可见；删除克隆即释放额度。权益降级不会删除已有克隆，但持有数超过新额度时需先删除部分克隆才能继续创建。
- WebSocket：HTTP 与 HTTPS server 均挂 `upgrade` → 路径匹配 → 会话鉴权 → 三态门禁 → TCP 管道；`persistent` 沙箱应用的 WS 经同一门禁透传到沙箱端口（与 HTTP 反代同路径语义：**转发前剥 `/app/<id>` 前缀并下发 `x-forwarded-prefix`**，raw 通道剥除 raw 段——2026-09-19 审计修复前 WS 未剥前缀，persistent 应用 WS 不可用）。
- **安全加固（2026-09-14 批）**：网关错误页全参数 HTML 转义 + `/app/:id` isSlug 校验（防反射/存储 XSS，线上实锤项）；托管应用越界判断改 `path.relative`（防 `..%2F兄弟目录` 跨用户读文件，线上实锤项）；`display_name` 剥 HTML 敏感字符 + 限长；persistent 沙箱响应头套用 `RESP_STRIP`（防 cookie tossing / CSP 覆写）并逐请求注入签名身份头；persistent 崩溃重启计数随条目继承（`MAX_RESTARTS` 真正生效防 CrashLoop）；invoked stdout/stderr 捕获 512KB 上限 + 执行排队上限 64（超出 429 `SANDBOX_BUSY`）。
- 限流：真令牌桶双维度（每用户 + 每 IP 兜底），`RATE_USER_PER_MIN` / `RATE_IP_PER_MIN`；IP 维度按 `TRUST_PROXY` 解析且 HTTP 与 WS upgrade 同语义（开启取 XFF 最右一跳，未开启用 socket 地址，防伪造 XFF 绕过限流）。
- 可见性 `visibility`（后端与 shared API 契约沿用 `login` 值，界面名称显示“站内”）：
  - `public` 全员（含匿名）
  - `login`（前端名称“站内”）站内共享：归属者与管理员可直接访问；其他用户不能直接打开，只能从“我的应用 → 站内共享”克隆到自己的账号
  - 已有数据库中的旧受限应用迁移为站内可见；未来仅使用公开、站内、仅自己三种范围
  - `private` 仅归属者（用户自建应用默认；门户对非归属者隐藏卡片）
- passUser 身份注入：`X-AAP-Identity`（base64url JSON：uid/kind/subject/aud/jti/iat/exp）+ `X-AAP-Identity-Sig`（HMAC-SHA256，密钥 `AAP_SIGN_SECRET`）。应用侧验签参考 `gateway/identity.ts` 的 `verifyIdentity`（aud 与 (kind,uid) 契约必查）。验签密钥自动下发：passUser 的 .aap 包沙箱 env 注入 `AAP_SIGN_SECRET`，上游应用在应用表单勾选时显示复制（详见 §3 密钥查看）。客户端自带的身份头在代理入口一律剥除（HTTP/WS/沙箱反代同一张剥离表），仅网关签名注入的可信。
- 统一页面元素：HTML 响应自动注入 `/portal-chrome.js`（在应用页面右下角显示后台配置的站点名称作为门户入口）；幂等、失败静默。覆盖三条通道：HTML 托管直出、persistent 反代直连（HTML 缓冲注入，2MB 上限）、沙箱外壳层（包代码不可触碰，raw 通道不重复注入）。

## 5. LLM 网关（/v1/*，M2）

接入零成本（OpenAI SDK）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://<host>:8080/v1", api_key="aapk_…")
```

- **凭据（C2）**：管理后台 → LLM 网关 → 签发；SHA-256 存储、可吊销、可按凭据限流（`perMinuteLimit`，默认 `RATE_LLM_PER_MIN`=60/分）。
- **模型路由（C3/C4）**：`llm_routes` 把公开模型名映射到上游真实模型；同模型多条 = failover 候选（`priority` 升序、同级 `weight` 加权随机）；切换条件：连接失败/超时/5xx/429/408。`multiplier`（千分比收入倍率）与 `costPer1k`（千 token 上游成本，分）用于毛利统计。
- **流式（C1）**：SSE 零缓冲透传，自动注入 `stream_options.include_usage` 捕获末帧 usage；不中途掐断。
- **超时（可配）**：`LLM_TTFB_TIMEOUT_SECONDS`（流式首字节，默认 15s，超时切候选；推理型模型首字节慢可调大）与 `LLM_TOTAL_TIMEOUT_SECONDS`（非流式整体，默认 120s）；流式闲置断开 `LLM_STREAM_IDLE_TIMEOUT`（默认 60s）。
- **计量（C5）**：`llm_ledger` append-only（usage 负 delta / grant 正 / adjust 正），用户归因来自应用转发的身份头（验签 `AAP_SIGN_SECRET`，aud=appId）；无头时仅应用级计量。计费倍率取**实际服务的候选**上游（同模型各路由 multiplier 可不同）。
- **预检（C6）**：请求前按 `max_tokens×倍率` 原子递减 `llm_balance_cache`，不足 → `402 INSUFFICIENT_BALANCE`；响应后按实际用量校正；**全候选失败/上游 4xx/流式中断等无用量路径即时全额退回预估扣减**；结算循环每分钟对账（重算近期活跃用户，吸收崩溃漂移），**对账重算补减进程内在途预估**（防预检扣减被周期性抹除）。流式转发有闲置超时（`LLM_STREAM_IDLE_TIMEOUT`，默认 60s 无新字节即断开并按已收 usage 结算），防上游挂起占满连接。**例外（2026-09-19 审计 P1-7 修复）：内容已流出但无 usage 帧（客户端断连/上游不回 include_usage）不再全额退回**——prompt 按请求体估算（字符数/4）、completion 按已转发字节数/4 估算入账；流末无换行符的 usage 残行也会补解析，真实值优先于估算。
- **无归因调用默认拒绝**：`/v1/chat/completions` 未携带可验签身份头时默认 `403 ATTRIBUTION_REQUIRED`（否则任何持 app token 者可绕过全部余额闸门免费调用，线上实锤项）；可信内网应用可由管理员将计费设置 `LLM_UNATTRIBUTED_POLICY` 切为 `allow`（仅计量不计费）。
- **用户归因**：应用把门户注入的身份头原样转发给网关即可。客户端自带的 `x-aap-identity*` 请求头在网关侧一律剥除（HTTP 与 WS 同语义），只认可信注入的签名头。
- **沙箱默认模型与生成上限**：`aap.llm.chat` 不指定 model 时按规范 §3.1 取 `LLM_DEFAULT_MODEL` 设置（计费组），未设置取模型目录排序第一个；目录为空返回可读 400。生成上限 `LLM_SANDBOX_MAX_TOKENS`（计费组）：包未显式指定 max_tokens 时注入，**0 = 不限制**（默认，模型自然收尾；推理型模型思考消耗大，包内硬编码上限会把 JSON 截半截——llm-proofread 实测）。
- **上游连通性测试**：`POST /api/admin/llm/upstreams/:id/test` 用该上游第一条启用路由的真实模型发 1-token chat ping（比 /models 列表更能暴露 key 失效、http/https 边缘拦截、模型名映射错误）；管理后台「LLM 网关 → 上游」每行有「测试」按钮。实测教训：DeepSeek 填 `http://api.deepseek.com` 会被边缘 401（Authentication Fails governor），必须 https。

## 6. 账号与通知通道

- **个人中心 Dashboard**：固定可折叠左侧导航，按「应用」「账户和安全」「权益中心」分组提供六个二级入口，导航项悬浮时显示高亮和轻微位移；隐藏门户页眉，品牌与用户入口分别置于侧栏顶部和底部，每次只展示一个带标题和说明的内容面板。应用管理、资料/MFA/会话管理、权益查看/获取操作均保留。

- 注册默认开放，注册页支持选填邀请码（可从 `?invite=...` 预填）；每个账号创建时自动分配唯一、可重复使用的邀请码。验证码通道 `MAIL_PROVIDER`：`smtp`（五项配置）或 `resend`（仅需 API Key，`RESEND_FROM` 留空用沙箱发件人）；都未配置时为日志兜底（验证码打到服务端日志，内网可离线）。
- **注册后权益选择**：邮箱注册完成验证后，普通新用户在存在启用权益包时进入 `/membership-selection` 选择套餐，服务端会拦截其他受保护 API 直至选择完成；零价包立即开通，积分足额时原子扣减并立即开通，人民币/美元套餐创建人工确认订单。无启用权益包时不要求选择套餐，新用户以未订阅状态进入个人中心，个人权益及额度为 0，注册赠送积分照常入账。若套餐在选择期间全部下架，用户可跳过选择继续使用未订阅账号。OIDC 新普通账号同样遵循此流程；首个管理员账号豁免，以便先完成后台配置。注册策略 `REGISTRATION_POINTS_GIFT` 为新建本地及 OIDC 账号赠送独立积分，默认 0，不追溯已有账号。开放注册不要求配置零价权益包。有效邀请码注册成功后，在同一数据库事务中累计邀请码使用数并按 `INVITE_REWARD_POINTS` 奖励邀请码属主，默认 100 分；管理员停用邀请码后仍可使用该邀请码完成开放注册，但不奖励。无效邀请码也不阻止注册。用户菜单底部的「账号电子身份卡」展示邀请码和带邀请码参数的注册二维码；后台邀请码列表显示属主、成功注册数并支持启停，不再提供手动生成。
- 防滥用：注册/找回/绑定全程 PoW + 可选 Turnstile；同通道 60s 限 1 条 + 24h 上限；同 IP 24h 注册 ≤5（**计数含已完成注册**——registrations 完成时置 `completed_at` 保留行而非删行，完成行超 24h 清、未完成行按 TTL 清；2026-09-19 审计前删行即释放名额，上限形同虚设）。**找回验证码错猜 ≥5 次（10 分钟窗）作废该邮箱全部待用码**，错猜计入登录失败队列（联动 PoW 门槛与 IP 自动封禁）；重新发码即恢复全新尝试额度。**找回密码发码的 60s 重发/日上限命中时对外静默 200**（与不存在的邮箱响应体完全一致，ghost 路径补等量 scrypt 拉齐时序量级）——429 差异曾是确定性账号枚举 oracle（2026-09-19 审计修复）。**客户端 PoW 求解优先 WebCrypto，非安全上下文（HTTP 部署，`crypto.subtle` 不存在）自动回退纯 JS SHA-256**（`apps/web/src/lib/sha256.ts`，默认难度 16 位纯 JS 亚秒级；服务端校验语义不变）——否则 NAS/内网 HTTP 访问时注册、绑定邮箱等全部 PoW 流程直接抛 `crypto.subtle.digest` TypeError（2026-09-22 修复）。
- MFA：TOTP（±1 窗 + 计数器重放拒绝，写回带 `last_used_counter < ?` 条件护栏防并发一码双用）+ Passkey（WebAuthn）+ 恢复码（10 枚一次性）+ 步升认证（密码或因子重验，`MFA_STEPUP_TTL` 内免重验）；管理员强制启用。**TOTP 登录/步升验证错猜 ≥5 次（10 分钟窗）作废当前会话**（`MFA_TOO_MANY_ATTEMPTS`），**并叠加账号维度持久计数（login_attempts 表 `mfa:<uid>` 命名空间，跨会话合计，成功清零，ip 列写哨兵不污染 IP 封禁面）**——单会话作废后重新登录不再重置额度（2026-09-19 审计修复）。**改密要求完全登录态**（`authState==='full'`，半登录态 403）。**强制流程服务端门禁（forceFlowGate）**：`mustChangePassword` 或「本地 admin 未绑 MFA」（OIDC 管理员委托 IdP 豁免）的会话除白名单端点（me/logout/change-password/mfa/*/step-up/*/portal/bootstrap）外一律 403 `FORCE_CHANGE_PASSWORD`/`FORCE_ENROLL_MFA`；登录/注册响应与 /auth/me 统一返回 `mustEnrollMfa`。**绑定新因子（TOTP enroll/confirm、Passkey 注册）需步升认证**（防被劫持会话静默绑新因子实现持久化）；登录即授予步升窗口（密码/Passkey/邮箱码本身就是刚验证过的因子，强制绑 MFA 流程因此不被卡）。**首启引导时序**：`ensureInitialAdmin` 等初始凭据 scrypt 落库后才 `listen`（曾 fire-and-forget，首秒内登录随机 401）。
- **前端 MFA 流转（2026-09-24）**：强制改密页成功后按 `/auth/me` 重算的 `mustEnrollMfa` 分流——仅未绑 MFA 的 admin 进绑定页，普通用户直达门户（曾写死跳 `/mfa-setup`，普通用户被误带入绑定页）。绑定页（`/mfa-setup`）挂载先查 `/api/auth/mfa/status` 预检：TOTP 已确认不自动重发 enroll（服务端会 409）；绑齐 TOTP+Passkey 引导去个人中心；非强制场景出示「跳过绑定」。步升窗口（5 分钟）过期时绑定/管理动作收到 403 `STEP_UP_REQUIRED` 自动弹步升窗重验后重试（`useStepUp`/`withStepUp` 共享于 `apps/web/src/components/StepUpModal.tsx`）。**个人中心·安全 Tab 的 MFA 管理卡片**：状态与恢复码余量展示、Passkey 列表/删除/注册本设备、解绑 TOTP（admin 保底约束由服务端消息透出）、恢复码重新生成（弹窗一次性出示），全部前置步升。
- **账户导航与头像**：门户页眉右侧头像/昵称入口以灰白信息面板展示账号资料、从当前有效订阅接口读取的权益名称与等级图标、角色和三段式主题选择；个人中心与「我的应用」使用固定可折叠侧栏，将品牌置顶、用户入口置底，并按「应用」「账户和安全」「权益中心」分组显示二级导航；每次仅渲染当前内容面板。浅色主题下个人中心页面、侧栏与信息卡片统一使用纯白背景；深色主题下个人中心各板块、表格（含分页区域）和主题相关弹窗统一使用深色表面，避免遗留浅色长条。其它页面用户菜单提供「个人中心」「我的应用」「退出登录」「账号电子身份卡」及管理员专属「管理后台」导航。浅色为默认主题，深色与跟随系统选项仅作用于个人中心和「我的应用」，通过同源 cookie 保持刷新后的选择，不写入后台；登录成功直接进入个人中心。头像文件位于 `apps/server/assets/icons`，新注册、本地管理员建号、OIDC 首登及首次管理员均按用户 ID 稳定分配；历史空头像账号由 `publicUserOf` 提供确定性回退，Web 构建通过 Vite glob 将头像打包。注销卡片位于账户信息面板末尾，操作需步升验证。
- **网页字体**：门户、认证页、操作导航、个人中心及管理后台共用系统无衬线字体栈（优先系统字体，中文依次回退到苹方/微软雅黑，再回退 `sans-serif`）；代码、密钥及验证码等需要对齐的内容保留专用等宽字体。
- **我的应用**：`/my-apps` 在个人中心共用侧栏与页面标题样式，分为“我自己的”“已共享的”“站内共享”；前两区卡片点击可访问，站内共享区显示不可直接访问、但可按权益克隆的应用。站内克隆复制应用文件和环境变量，不复制应用运行期 `app.sqlite`/`storage` 数据，副本固定为仅自己可见；删除后释放一个克隆名额。可访问卡片带轻量 3D 阴影与悬浮效果，悬停时右侧以抽屉动效展示访问二维码。`GET /api/apps/shared` 返回可直接访问的公开共享应用，`GET /api/apps/site-shared` 返回可克隆的站内共享应用，`GET /api/apps/mine` 返回用户托管应用及克隆标记。发布、配置环境变量、删除等操作仍集中在「应用管理」分区。
- **应用设置**：个人中心「应用管理」的已创建应用列表以「设置」弹窗集中管理图标、名称、描述和可见范围；图标仅通过图片上传修改，保存于数据卷 `DATA_DIR/app-private/icons/<应用 ID 的 SHA-256>/`，不进入可下载的应用文件目录。`POST /api/apps/:id/icon` 只允许归属者上传受签名校验的 PNG/JPEG/GIF/WebP 图片（最大 2 MB）；读取接口按应用门户可见范围校验。AWPK 包的环境变量也可在同一弹窗中配置，唯一的「保存设置」按钮会先保存环境变量，再保存基本信息和可见范围；若后一步失败会明确提示环境变量已先行保存。`PUT /api/apps/:id/settings` 仅允许归属者修改名称、描述及可见范围，并校验字段长度；环境变量仍经 `/api/apps/:id/env` 保存并加密。已创建应用列表以列展示安装日期、包大小、版本和平台支持，不再点击名称展开详情。
- **个人中心权益**：「我的权益」解释权益对服务范围、有效期、应用上传名额及 Token 额度的作用，并突出实际余额；历史订阅仅展示权益订阅订单。「获取权益」说明可通过积分兑换和兑换码获取指定权益，额度订单以 Token 额度描述。
- **门户首页与认证页**：首页品牌文案读取门户引导接口 `branding.siteName`，欢迎标题、品牌介绍和上传说明均随后台站点名称设置变化；首页按首屏欢迎区、应用列表、在售权益包、常见问题纵向排列；发现应用卡片带轻量 3D 阴影与悬浮效果，悬停时右侧以抽屉动效展示访问二维码，点击卡片直接打开应用；首页页眉固定在顶部，未滚动时完全透明并显示灰白导航文字与白底黑字登录按钮，滚动后切换为毛玻璃乳白半透明背景、灰黑导航文字与黑底白字登录按钮；「发现应用」、权益、FAQ 与登录按钮等间距排列，不显示区块入口选中态。其它显示门户页眉的页面保持磨砂透明背景；页眉导航平滑定位到对应区块。「现在开始」对未登录用户进入分步应用制作导航（五章使用中文数字编号、精简章节内容与留白以减少滚动，逐步阅读或跳过后进入登录/注册），已登录用户直达应用管理；其它页面页眉的「操作指南」进入同一分步导航。登录成功不再弹出操作指南。权益包通过公开只读接口 `/api/portal/plans` 获取，仅返回管理员启用的套餐；FAQ 与操作指南共用同一份问答数据。登录/注册页使用 `apps/server/assets/login.jpg` 铺满左栏，提供服务条款与可接受使用政策静态页并显示站点页脚；首页首屏使用 `apps/server/assets/home-background.png`，其余区块为浅色背景。
- 防爆破双维度：IP 维度之外增加**账号维度**失败计数（`login_attempts.user_key`），同账号跨 IP 分布式撞库同样触发 PoW 要求。邀请码归属用户唯一索引保证每个账号只有一个专属码；并发注册通过事务锁定邀请码行，使有效注册计数和邀请积分奖励原子生效。
- OIDC SSO：配置 Issuer/ClientId/Secret 即启用（重启生效）；`OIDC_ADMIN_SUBJECTS` 首登提升管理员；待批准账号重复登录干净回到待批提示（不下发即刻失效的会话）。

## 7. 订阅与计费（M3）

- **功能订阅**：`membership_plans`（名称/对应分组/时长/人民币分或美元美分或整数积分/赠额度/可创建应用数量/可克隆应用数量/0–5 权益等级）→ 人民币与美元套餐创建 manual 订单、管理员运营面板确认到账；积分套餐从独立用户积分余额原子扣减并立即开通，不与 LLM Token 共用。套餐和订单记录币种；历史套餐、订单默认人民币并保留原金额。更高等级套餐激活后立即替换当前权益，同等级套餐从当前权益到期时间续期（包括同等级不同套餐），较低等级套餐在当前权益到期前拒绝订阅；订单创建和确认时都会校验等级，避免待确认订单覆盖更新的高等级权益。开通后自动入组 + 赠额度到账；到期结算循环自动降级（移出分组、数据保留）。权益等级 1–5 使用 `apps/server/assets/tier-icons` 对应图标，等级 0 显示基础等级文本。**订单确认/会员开通/积分扣减均在事务内**：置 paid 与入账、积分扣减与权益开通同生共死。
- **套餐编辑**：管理后台运营面板可编辑已发布套餐（分组保持不变）。可创建/克隆应用数更新后立即用于该套餐所有有效订阅者的额度检查；下调额度不会删除已有应用，若已用数量超过新上限则暂时不能继续创建/克隆。Token 赠额、价格和有效期只用于此后新开通/续订，不会追溯调整已发 Token 余额或当前订阅到期时间；停售状态仍可单独切换。
- **公开应用积分奖励**：后台用户分组配置每公开发布一个应用奖励的整数积分；用户首次将自有托管应用设为公开时，按其所属分组基准奖励一次，并将奖励值记录在应用上。可见范围切换或重复发布不重复奖励；删除获奖应用时在同一事务内扣回记录的奖励值，余额最低为 0。修改分组奖励只影响之后首次公开的应用，不改变已记录奖励。
- **额度充值**：订单按 `TOPUP_TOKENS_PER_FEN` 折算到账；管理员可通过 `SHOW_TOPUP_PANEL` 控制用户中心「额度充值」卡片（新安装默认隐藏，兑换码不受影响）。
- **卡券码**：批量生成额度码/订阅码（`AAP-XXXX-XXXX-XXXX`），原子兑换防双花，可作废/设有效期；兑换走 `grantTokens`（三触发失效缓存）；批次摘要按批次与类型分组，码列表按创建时间和码值排序，兼容 PostgreSQL。
- **运营面板**：30 天收入/成本/毛利（成本按路由 `costPer1k`）、余额与消耗排行、应用热度、订单确认；用户额度发放/调减入口与计费设置（`TOPUP_TOKENS_PER_FEN`、`SHOW_TOPUP_PANEL`、`SHOW_ORDERS_PANEL`）也在本页。
- 订单与卡券码列表分别由 `GET /api/admin/billing/orders` 和 `GET /api/admin/redeem/codes` 提供，响应中的 `orders`、`codes` 均为完整数组。
- **用户端入口**：个人中心「我的权益」分区展示当前权益详情及可选择权益包，选择后显示账单摘要；支付创建待确认订单，管理员确认到账后生效。支持使用兑换码；「额度充值」和「我的订单」卡片默认隐藏，可分别通过 `SHOW_TOPUP_PANEL` 与 `SHOW_ORDERS_PANEL` 控制显示。
- **注册与权益**：新普通用户注册后在存在启用权益包时选择套餐；零价包即时激活并加入权益分组，付费包生成待确认订单，管理员确认后生效。无启用权益包时直接以未订阅状态进入个人中心。开放注册不要求存在零价权益包，也不会因此限制停用或删除最后一个零价包；删除仍受套餐正在被订阅等既有约束限制。
- **初始管理员积分**：首启创建的初始管理员获得 99,999,999 积分；数据迁移也会为已有实例中积分为 0 的首位管理员补齐一次。
- **个人应用管理**：`GET /api/apps/mine` 返回归属者的 HTML/Python 托管包；选择 AWPK 后，在上传按钮下方左对齐显示不确定进度条，直到校验/依赖安装完成，进行中禁用重复上传；上传成功后刷新列表。已创建应用列表以紧凑列展示安装日期、AWPK 上传大小、版本和平台支持，平台支持用图标标识数据库、大模型、网络白名单与存储能力，默认每页十项、不产生横向滚动条，也不再通过点击名称展开详情；设置和删除使用带无障碍名称的图标按钮。删除走 `DELETE /api/apps/:id`，要求归属者并通过步升身份验证，删除时清理包目录、持久进程及应用凭据。
- **套餐兑换码链接**：管理员创建套餐时可选填 `redeemUrl`，仅接受有效的 HTTP/HTTPS 外链；个人中心「订阅账单」在对应套餐配置了链接时展示「当前方案支持兑换码?去获取」，新标签页打开并启用 `noopener noreferrer`。
- **AWPK 版本约定**：同一应用的更新包必须使用高于当前安装/上次交付的三段版本号；常规迭代至少递增 PATCH，不能重复版本或重置版本。Agent 应先查旧包/交付记录，无法确认时向用户询问；平台不自动递增版本。

## 8. 分发（deploy/）

- Docker：`deploy/docker/Dockerfile`（两阶段，含 web 构建与文档资产），`docker-compose.yml`；`DATA_DIR=/data` 卷。
- FPK（**原生形态**，2026-09 定稿）：`deploy/fpk/build-fpk.sh <版本> <x86|arm|all>`——载荷 = `deploy/native` 自包含包，`manifest`/`config`/`cmd`/`wizard`/双尺寸图标按官方 fnpack 必检清单组装；**主入口 = 本服务自主监听端口**（向导 `wizard_port` 默认 8080，绑 0.0.0.0，`checkport=false`），与 Docker 形态路径行为完全一致；桌面图标 = `type=url` 端口快捷方式（不经飞牛统一网关——跨源 iframe 会被门户自身 frame-ancestors 拦截）；业务鉴权全部走门户自有账号体系。服务端 `GATEWAY_PREFIX`/`SOCKET_PATH`/`HOST` 能力保留休眠。取舍与真机待验证清单见 `deploy/fpk/README.md`。Docker 形态不再出 FPK。
- 原生（无 Docker）：`deploy/native/build-native.sh linux/arm64|linux/amd64` —— 在 node:22-bookworm（glibc）容器内构建，产出自包含应用包（Node 22、服务端/前端构建产物与 PostgreSQL 迁移）；需外部 PostgreSQL 17 和系统 `python3`。运行方式与安全红线（systemd 专用用户替代 `SANDBOX_UID/GID` 降权）见包内 `README-NATIVE.md`。
- CI：`.github/workflows/docker-publish.yml` —— push main / tag `v*`：多架构镜像 → ghcr.io（tag 冒烟 `/api/health`）；原生 FPK 与镜像发布解耦，按 amd64/arm64 矩阵构建自包含包 → 打包 x86/arm 双 FPK 附 Release；tag 必须与根 `package.json.version` 一致。
- 测试机快速部署：`./deploy/fast-deploy.sh`（本地构建产物 + rsync + **docker cp** 灌入容器重启，零服务器下载——轻量机带宽小，服务器上构建曾两次整机饿死）；仅依赖变更（lockfile）才需服务器 `compose build`（Dockerfile 已 manifest 先行 COPY + pnpm store BuildKit 缓存挂载，源码变更不再触发全量拉包）。

## 9. 约束与纪律

- 迁移：schema 改动后 `pnpm db:generate`，禁手改已发布迁移。
- 单位指纹零进入：`X-Office-*`、校名/校色不进本仓库。
- 契约变更：`packages/shared` 为单一来源；`.awpk` 接口面变更必须升版 `app-develop.skill` 并同步 internal skill。
- 审计：账号/应用/网关/计费的关键动作全部落 `audit_logs`（保留期可配，分批清理）。
- **沙箱隔离现状**：`.awpk` Python 进程的受控出网通道是平台 egress 代理（manifest 白名单 + IP 黑名单**逐跳**校验，`routes/aap.ts`）；runner 内置 **Python 层出站守卫**（`connect` 仅放行 `AAP_PLATFORM`，直连其余地址/Unix socket 报错，`AAP_NET_GUARD=0` 关闭）；子进程环境变量走白名单（`lib/sandbox.ts` 的 `SANDBOX_ENV_KEYS`）；invoked 执行有全局并发上限（`SANDBOX_MAX_CONCURRENT_RUNS`，默认 8，超出排队防进程炸弹）；persistent 有全局进程数上限（`SANDBOX_MAX_PERSISTENT`，默认 12，超限回收最久未用进程——任务状态应落 aap.db，重拉无损）；**persistent 空闲回收时长可配**（`SANDBOX_IDLE_RECYCLE_SECONDS`，默认 300s，最小 30s，管理端改完即时生效）；沙箱以预建的 ai-app-panel 用户（10001）**默认降权运行**（compose `SANDBOX_UID`/`SANDBOX_GID` 已默认启用；新部署按当前目录权限初始化，后续新上传包目录由平台自动放宽权限）。**开放注册 + 允许用户上传包的部署必须保持降权**，否则任意注册用户可读全站凭据哈希与 master.key（二轮渗透实测）。门户业务数据位于 PostgreSQL；托管应用的 `app.sqlite` 是应用自己的状态数据。`master.key` 文件权限为 0600。**进程级禁网、CPU/内存限额与 ns/cgroups 硬隔离仍未实装**（Python 层守卫属纵深防御，非硬保证）；第三方包须通过上传阶段的包结构、manifest、当前权益包上传数量与依赖校验，公开发布不限制应用数量。
- **应用环境变量 / 机密（G6）**：包在 manifest `env` 声明变量（required/secret/pattern/default，保留名黑名单防劫持 `AAP_*`/`PORT`/代理变量等平台注入面，`parseEnvSpec`），归属者/管理员经 `GET/PUT /api/apps/:id/env` 填值（`app_env_vars` 表 AES-256-GCM 加密落盘，secret 只写不读仅回尾 4 位 hint，审计只记名不记值）。除机密外，env 亦是**应用级默认配置**的承载（如 llm-proofread 的 `PROOFREAD_PROMPT`/`COHERENCE_PROMPT`：归属者配置对所有用户生效，用户个人设置可覆盖）；`baseEnv()` 在 invoked/persistent 沙箱启动时注入（未配置非机密变量回退声明 default）；必填缺配在执行（400 ENV_MISSING）/拉起（503 错误页）时明确拦截；persistent 配置变更后自动重启进程。入口：管理后台·应用管理与用户中心·我的应用的「环境变量」弹窗。规范见 `./app-develop.skill-v0.3.md` §1.1。
- 包上传安全语义：用户提交（`POST /api/apps/submit`）与执行（`/api/apps/:id/run`）均要求登录；正式目录的写入/删除一律在归属校验与同名查重之后（admin 上传 409 不触碰既有站点目录）；临时目录按请求唯一命名；15MB 包体 JSON 在鉴权之后解析（匿名大包 DoS 面收敛）。
- **python 包第三方依赖（skill v0.2.6 声明制）**：manifest `requirements` 声明（`parseRequirements` 仅收「名称[extras]+版本约束」，拒 URL/本地路径/-r，上限 32 条），**上传/更新时服务端 `pip install --only-binary=:all: --target <appsites>/<id>/.deps`**（`lib/pydeps.ts`，超时 300s；容器日志记录开始、每 30 秒仍在安装的状态、完成或失败；失败=上传被拒并清理临时目录，不带病上线）；个人中心和管理后台会提示依赖安装阶段及最长等待时间。沙箱 `baseEnv` 注入 `PYTHONPATH=.deps`（native/FPK `start.sh` 自检补装的预置框架目录经 `AAP_PREINSTALLED_PYTHONPATH` 前置——docker 镜像预装 py3-flask 无此环节）。安装源走「应用网关 → pip 索引源」设置（`PIP_INDEX_URL`，默认官方 PyPI）；新版本不再声明的依赖更新时自动清除；`.deps` 在数据卷应用目录下，容器重建/升级不丢。管理端包预览展示依赖清单。
- **egress 出站代理（P0-3 修复）**：白名单域名经 `dns.lookup` 解析后对全部 A/AAAA 复核私网/保留段黑名单（环回/RFC1918/169.254 链路本地/CGNAT/ULA 等，防 `*.nip.io` 类 DNS 绕过，线上实锤项）；IP 字面量与 localhost/.local/.internal 仍一律拒绝；出站失败详情只进服务端日志不回传调用者（防内网探测 oracle）。残留风险：解析与请求间存在理论 TOCTOU 窗口，容器形态网络隔离补齐后消除。 **内网部署例外**：管理员可在「应用网关 → 内网出站白名单」（`EGRESS_INTRANET_ALLOWLIST`）配置域名/IP/IPv4 CIDR，命中即完全放行（管理员权威高于包声明，无需包 manifest 重复声明；CIDR 区间无法逐 IP 声明）；169.254 链路本地无条件拒绝。未命中时包 manifest 照常生效、内网目标照常拒绝。**自定义请求头转发**：`aap.http.fetch(url, timeout, headers)` 支持包传自定义头（第三方 API 鉴权场景，密钥经门户环境变量注入）；≤16 个、值 ≤4KB，Host/Connection/Content-Length/Proxy-* 等逐跳与托管头剥除；响应 `{"status": 上游状态码, "body": 文本≤500KB}`。
- **敏感配置加密**：settings 的 secret 型配置（`AAP_SIGN_SECRET`/`SMTP_PASS`/`RESEND_API_KEY`/`OIDC_CLIENT_SECRET`）落盘前 AES-256-GCM 加密（`enc:` 前缀自描述；存量明文读取兼容，后台再次保存即转密文）。
- **传输与跳转**：HTTPS 实际启用时全站挂 HSTS（2 年，主域）；HTTP→HTTPS 跳转目标只认 `ACME_DOMAIN`（不反射请求 Host，防直达源 IP 场景的钓鱼/缓存投毒组件）；**loopback Host（127.0.0.1/localhost/::1）豁免跳转**——沙箱 runner 与 FPK 统一网关的平台内部 POST 调用若被 302 到公网域名，跟随重定向会降级为 GET 打断全部沙箱出站（llm-proofread 实测）。
- **信息泄露收敛**：匿名 `/api/health` 仅回 ok（version/uptime 移入管理员总览）；登录 401 不再回 failures/banned；`/api/dev/guide` 需登录。
- **身份头（X-AAP-Identity）**：验签强制 exp 存在且未过期；jti 一次性（TTL 窗口内防重放；平台内部归因 `allowReplay` 豁免）。`/api/admin/redeem/*` 显式挂 `requireAdmin`（不再依赖挂载顺序偶然保护）。`AAP_PLATFORM`/沙箱平台地址一律取明文 HTTP 环回口（`loopbackPlatformPort`：HTTP 到达取 `req.socket.localPort`，**TLS 口到达回落 `config.port`**——第二轮渗透 NEW-2，8443 是 TLS 监听、明文调用必断），绝不信客户端 Host。
- 包签名：`.awpk` 不要求签名；即使包内含 `signature.json`，平台也不验证其签名或维护发布者信任列表。`packages/aap-sdk/sign-aap.mjs` 是可选的离线工具，不属于上传流程。
- OIDC 管理面板：「安全」页展示 OIDC 配置组，并在顶部按当前访问地址自动生成**回调地址（一键复制）**——在 IdP 登记的重定向 URI 即该地址；Issuer/ClientId/Secret 修改后需重启生效。
