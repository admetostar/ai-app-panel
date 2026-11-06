---
name: app-develop-internal
description: "涉及网关 / LLM 网关 / 沙箱 / 计费 / 账号安全的架构设计或 ADR 复核，或 .awpk 接口面（manifest / aap.*）契约变更时用。常规 bug 修复、UI/文案/测试改动不需要。"
version: 2.6.4
---

# ai-app-panel 开发指南

> v2.6.4 变更：应用开发规范 v0.3.4 强制 LLM 调用透传成对的平台身份头，补充单线程与后台任务归因规则及 `MODEL` 选型建议。
>
> v2.6.3 变更：应用开发规范 v0.3.3 要求更新同一 AWPK 应用时递增 `manifest.version`，未知当前版本先询问，不得重置或猜测。
>
> v2.6.2 变更：应用开发规范 v0.3.2 统一规定 LLM 应用使用必填 `env.MODEL`，模型从门户目录配置并显式传入 SDK。
>
> v2.6.0 变更：应用包契约切换为 AWPK（ZIP 容器，必须使用 `.awpk` 扩展名）；上传、预览与安装拒绝旧 `.asp-app`/`.zip` 扩展名；用户上传 Python 应用的 requirements 也在正式安装前执行依赖安装。
>
> v2.6.1 变更：未配置 `SITE_DOMAIN` 时，应用卡片使用同源 `/app/<id>/` 路径和 iframe 沙箱，不再生成 `<id>.localhost:<内部服务端口>`；配置域名后仍使用独立应用 origin。
>
> v2.5.0 变更：同步应用开发规范 v0.2.9 的实际能力闸与资源边界；明确独立 origin 支持应用自己的浏览器会话，Python 网络守卫不是硬隔离，且当前无 CPU/内存及数据库硬配额。
>
> v2.4.0 变更：应用访问改用独立子域名；新增 `SITE_DOMAIN`、`*.localhost` 本地入口、通配 DNS/证书要求、平台与应用 Cookie 隔离及旧路径跳转兼容。
>
> v2.3.4 变更：移除应用包上传签名要求与平台信任公钥配置；用户和管理员均可直接上传，用户包默认私有并可自行公开。
>
> v2.3.2 变更：触发描述收窄并更名 app-develop-internal（避免与包作者规范同名）；PRD 指针修正为仓库真实路径；§9.5 压缩为实现要点（细节归 docs/DEVELOPMENT.md §9 单一来源）；§十 状态快照校正（ed25519 免审、persistent WS 透传均已实装；易过期的测试计数移除）。
>
> v2.3.1 变更：§二 补两条实测经验——persistent 沙箱反代剥 /app/<id> 前缀（下发 x-forwarded-prefix、Location 镜像回写）；HTTPS_REDIRECT 按 loopback Host 豁免（沙箱内部 POST 曾被 302→GET 打断全部出站）。
> v2.3.0 变更：新增 §9.5「应用环境变量 / 机密（G6）」——manifest.env 声明 + 加密存储 + 沙箱启动注入；与 app-develop 规范 v0.2.2 §1.1 配套。
> v2.2.0 变更：新增 §十「实现状态快照（M1–M3 交付）」；§三 身份头更名 X-AAP-* 并写明密钥来源。
> v2.1.0 变更：新增 §九「沙箱日志收口与调试沙箱」，与 app-develop 规范 v0.2（§3.5 日志 / §3.6 统一元素 / §八 aap-dev）配套。

基于 neon9809 同学的上游项目二次开发：自托管 AI 应用网关与门户，项目名称为 `ai-app-panel`。
- **PRD**：`./ai-app-panel-PRD-v0.3.1.md`（v0.3+，功能按 A–G 功能域组织：A 门户与身份 / B 应用网关 / C LLM 网关 / D 计费 / E 管理后台 / F 分发与运行 / G 生态；里程碑 M1–M4 只在第 7 节，与功能域编号解耦）
- **参考实现** = 他的私有项目 office-tool（Node/Express，CUGB 办公门户）。**私有代码可借鉴思路与代码，但任何单位指纹（校名/校色/校徽/内置业务工具）不得进入 OSS 版。**

## 一、硬决策（ADR，勿再反复讨论）

| # | 决策 |
|---|---|
| 1 | **应用独立 origin**：配置 `SITE_DOMAIN` 时应用通过 `<id>.<SITE_DOMAIN>` 路由；未配置时卡片使用同源 `/app/<id>/` 路径与 opaque-origin iframe 沙箱，不向浏览器暴露内部服务端口。子域名入口在门户 `/api`、`/v1` 路由之前处理。 |
| 2 | **WebSocket 透传在 P0**（AI 聊天应用依赖；`upgrade` 事件 → 路径匹配 → 鉴权 → TCP 双向管道） |
| 3 | **语言 Node.js/TypeScript**（复用参考实现已验证逻辑；ACME 用 acme-client） |
| 4 | **单组织**，不做多租户/白标 |
| 5 | **计费三种价值**：会员订阅提供应用创建、克隆等权益并支持人民币/美元人工确认与独立积分兑换；LLM Token 充值仅服务模型用量，不与积分混用；不做任意 SQL 级按量账单 |
| 6 | **品牌全数据化**：logo/站名/主题/页脚/ICP+公安备案号组件；内置 ≥6 套主题（复用 fnos-dashboard 主题方法论） |
| 7 | **分发两手抓（2026-09 定稿）**：飞牛 FPK = **原生形态**（载荷 `deploy/native` 自包含包 + `install_dep_apps=python312`，SQLite 内置，不用飞牛 database）+ Docker（非飞牛用户，DATABASE_URL/SQLite 均可）；**两形态都是端口主入口**（FPK 端口向导化 wizard_port），路径行为完全一致 |
| 8 | **飞牛桌面图标 = 纯快捷方式（2026-09 定稿）**：type=url 端口入口新标签页打开面板，**不经统一网关**（跨源 iframe 会被门户 frame-ancestors 拦截，不放行）；面板与全部业务都走门户自有端口与账号体系（不消费 X-Trim-* 身份头、不做 NAS 管理员免密建会话——原 F3 免密通道废弃；网关 socket/前缀能力服务端保留休眠） |
| 9 | **公用设施集中配置**：数据库（平台 DAL 统一访问，应用不直连）/ LLM 网关 / 反向代理，应用零配置受益 |
| 10 | **管理面板体验是 P0 验收硬指标**（详见下文 E 要求） |
| 11 | **首次初始化（2026-09 定稿）**：FPK 与 Docker 同流程 = 首启随机初始密码落数据目录 `app.log`（Docker 为容器日志 + data/ 一次性凭据文件）→ 登录强制改密。收敛到同一份 checklist；admin 强制 MFA 不可关 |

## 二、路径模式反代的坑与解法（核心经验，office-tool 实战验证）

路径模式是未配置 `SITE_DOMAIN` 时的门户卡片入口，以及已配置域名时的旧链接兼容入口。配置域名后门户卡片使用独立应用 origin。上游应用可经 `<id>.<SITE_DOMAIN>` 在根路径工作，`/app/<id>/` 代理仍需处理上游假设自己位于根路径的情况。已验证解法组合：

1. **HTML 改写**：`href/src/poster/action/srcset` 的根绝对路径 `/xxx` → `/app/<id>/xxx`；`srcset` 逐段处理。
2. **`<base>` 注入**：修正相对链接基准；base 指向上游真实挂载点（query 凭据型上游 → 根；path 凭据型上游 → 凭据路径）。
3. **运行时猴补丁（关键）**：注入脚本猴补 `XMLHttpRequest.open` / `window.fetch` / `script.src` setter，把同源根绝对路径请求改写到代理前缀——SPA 的后端 API、Next.js chunk 才能继续走代理；`history.replaceState` 剥掉前缀让前端路由正常匹配。
4. **响应头改写**：`Link` 预加载头绝对路径也要改写；`Location` 仅同源重定向改写。
5. **路径穿越防御**：逐段拒绝 `.`/`..`（含 URL 编码变体）——URL 构造器归一化会吃掉 `..` 导致逃出 base path。
6. **保留上游 base path 与 query**：只取 origin 会打挂子路径部署的上游、丢 url 凭据。
7. **SSE/流式**：禁缓冲，`Readable.fromWeb(upstream.body).pipe(res)`；客户端断开销毁上游流；带体请求走 undici 必须显式 `duplex: 'half'`（否则 POST/PUT 全 502 而 GET 正常——经典坑）。
8. **凭据注入**：上游凭据存服务端注册表（urlSecret），转发时才拼入，绝不写配置下发浏览器；支持 path 型凭据（Dify `/chat/<id>`，路径即凭据）。
9. **限流**：双维度令牌桶——每登录用户为主（NAT 场景同事不互相挤爆）+ 每 IP 兜底。
10. **明示限制**：不做 JS/HTML 深度改写；兼容路径模式不转发 Cookie。独立应用 origin 会剥除 `Set-Cookie` 的 `Domain` 并固定 `Path=/`，应用 Cookie 限定为当前主机，不允许覆盖平台会话 Cookie。
11. **persistent 沙箱反代**（实装于 G2）：转发前剥 `/app/<id>` 前缀（包路由挂根，规范模板 `@app.route("/")` 才能命中；此前全路径转发使 ip-analyzer 直接 Werkzeug 404），前缀经 `x-forwarded-prefix` 下发、站内相对 `Location` 镜像回写前缀。**HTTPS_REDIRECT 必须豁免 loopback Host**：沙箱 runner 走 `http://127.0.0.1:<port>` 调平台 egress/LLM，302 到公网域名会被 urllib 跟随且 POST 降级 GET，全部沙箱出站断连（ip-analyzer 实测「出站请求被平台拒绝」）。

### 独立应用 origin

- 管理员在「站点设置」配置应用域名根，与 TLS 证书配置分开。配置后每个应用使用 `<appId>.<SITE_DOMAIN>` 独立 origin；未配置时通过门户同源 `/app/<id>/` 路径运行，用户上传应用仍由 opaque-origin iframe 沙箱隔离，浏览器地址不会暴露服务端内部端口。需要验证应用的 localStorage、sessionStorage 或 host-only Cookie 时，必须配置应用域名。
- 生产部署需配置 `*.<SITE_DOMAIN>` DNS 与通配 TLS 证书。当前 ACME HTTP-01 只支持单域名签发，因此通配证书需手动上传。
- 应用 origin 上的 `/api`、`/v1` 不落入门户路由；平台会话 Cookie 不转发给应用，应用自有 Cookie 去除 Domain、限定当前主机且不能覆盖平台会话 Cookie。应用请求的 `Origin`/`Referer` 透传，保留其自身 CSRF 校验能力。
- 应用 origin 是普通网站 origin，应用可使用本 origin 的 localStorage/sessionStorage/host-only Cookie 实现自己的账号会话；不得依赖门户 DOM、门户存储或平台登录 Cookie。平台仍在应用入口执行应用可见性/登录门禁。
- 配置了应用域名时，旧 `/app/<id>/...` 用户应用入口以 307 保留深层路径跳转到新 origin；旧 `/raw/` 标记会从目标路径移除。未配置时请求留在路径模式并继续使用 iframe 沙箱。

### AWPK 能力与资源边界（与用户技能 v0.3.1 同步）

- 允许的 SDK 面：`aap.llm.chat`、`aap.db.execute/query`、`aap.storage.put/get/delete/list`、`aap.http.fetch`、`aap.log`。`llm` 未声明时平台网关强制拒绝；`db`/`storage` 当前没有逐项运行时能力闸，但开发契约要求仍须按需最小声明。
- 上传 JSON body ≤15 MiB；ZIP 解压最多 2,000 条目且总量 ≤100 MiB；requirements ≤32 且只安装 wheel；env ≤16 项，value ≤8,192 字符、default ≤4,096、pattern ≤200。
- invoked 单次 30 秒、全局并发默认 8、排队最多 64；stdout/stderr 捕获各 512 KiB。persistent 默认最多 12 个进程、空闲回收 300 秒（最小 30 秒）、崩溃重启最多 3 次。storage 默认每应用 10 MiB；SQLite 当前无硬容量配额。
- egress 仅 HTTP(S) GET，经代理逐跳校验白名单与 DNS/IP；超时 15 秒、最多 5 次重定向、响应正文最多 500,000 字符、自定义头最多 16 项。管理员 `EGRESS_INTRANET_ALLOWLIST` 可放行精确主机/CIDR，链路本地仍拒绝。
- 当前没有 per-app CPU/内存硬限额；Python runner socket monkeypatch 是纵深防御，不是 OS/容器级隔离。任何文档和包设计都不得声称这些未实现的硬限制。

## 三、身份传递（passUser）

代理转发时注入：`X-AAP-Identity: base64url(JSON payload)` + `X-AAP-Identity-Sig: hex(HMAC-SHA256(secret, payload))`。
签名密钥 = 平台设置 `AAP_SIGN_SECRET`（管理后台 → 安全 → 高级项可查看/轮换；首启自动随机生成，或用环境变量 AAP_SIGN_SECRET 设初值）。

- payload 必含：`aud`（目标工具 id，防身份头转发到其他上游重放）、`jti`（一次性随机串）、`iat/exp`（10 分钟 TTL）、`kind`+`uid`（**本地账号与 OIDC 分表自增，仅按 uid 隔离会同号串号——必须 (kind, uid) 联合或用 subject**）
- 消费端校验：签名（timingSafeEqual）、exp、aud 与自身 id 一致
- **验签密钥自动下发（2026-09-22）**：勾选 passUser 的 .aap 包，沙箱 env 自动注入 `AAP_SIGN_SECRET`（全局身份签名密钥；`AAP_` 保留名上传即拒声明，包不可覆盖）。轮换密钥（stopAllPersistent）或切换 passUser 开关（stopPersistentFor）自动停起 persistent 进程，下次访问以新 env 拉起。上游（external）应用无沙箱：管理后台应用表单勾选 passUser 时展示密钥供复制配置
- passUser 同时是 **LLM 网关用户级计量的归因通道**（身份头随请求链进网关，用户级 token 归因零成本）
- **LLM 归因契约**：persistent 应用须在 Flask 请求上下文内成对读取 `X-AAP-Identity` 与 `X-AAP-Identity-Sig`，通过 `(payload, sig)` 显式传给每次 `aap.llm.chat` / `chat_stream`。单线程调用也应显式传元组；线程池/后台任务须在请求线程内捕获并逐层传递，不能在 worker 中读取 Flask `request`，不能只传 payload，缺失身份不得匿名重试。签名身份有效期 10 分钟，不进入数据库、持久队列或日志。invoked 模式使用平台注入的 `AAP_IDENTITY_PAYLOAD` / `AAP_IDENTITY_SIG`，后台 worker 可在提交前捕获并作为 `identity=` 参数传递。

## 四、LLM 网关 + 计费（C/D 域核心设计）

**定位**：平台自带 OpenAI 兼容中转网关，应用调大模型一律走网关不直连云厂商；对调用形态（Agent/单次任务）无感。（早期「对外提供 MCP/manifest」的理解已被 Neon 否掉。）

- 接入零成本：OpenAI SDK 改 `base_url` + `api_key`（网关 app-token）即可
- 凭据分层：真实上游 key 只存网关侧，管理员统一维护/轮换；应用凭据可吊销可限额
- 模型目录：聚合多上游出统一 `/v1/models`；应用 `model` 字段选模型，网关按模型路由
- 路由：同模型多上游 failover（超时/5xx/限流切换）+ 健康检查 + 轮询/加权；SSE 零缓冲
- **C/D 边界：账本只有一份**——C 的用量流水（append-only，只记不判）；**余额只有一处**——D 读流水结算。C 在请求路径上（记录者+预检者），D 在请求路径外（结算者）
- **额度拦截两道闸**：① C 预检缓存（按模型倍率原子递减预估成本，无余额直接 402，请求不出网关）；② D 结算引擎异步消费流水校正余额，打穿 → 欠费态 + **主动失效 C 缓存**。漏账上限 = 并发在途请求预估成本（可控，非账目错误）
- **缓存同步三触发**：扣款（欠费）、充值到账、管理员手动调额，都必须失效 C 预检缓存（否则「充了值还被拒」灵异事件）；单机用进程内事件总线
- **流式计量**：SSE token 数结束时才确定；预检按 max_tokens/历史均值估，**不在流中途掐断**，让流完 + 事后校正 + 欠费态兜底
- 计费闭环：充值进 token 额度池 → 按模型单价扣减（不同模型不同倍率，管理员定价）→ 余额不足拒付；会员订阅与 token 池两条独立计费线可叠加；运营面板看余额排行/应用热度/上游成本 vs 毛利

## 五、安全栈（P0 直接移植 office-tool）

PoW 登录 proof-of-work、登录失败计数、IP 封禁（累犯时长倍增）、CSRF Origin 校验、scrypt 口令哈希、审计日志、`TRUST_PROXY` 语义（无前置代理置 0，防伪造 XFF 绕过封禁）。

**MFA 要点**：TOTP（RFC 6238；±1 窗口、重放拒绝、恢复码 10 枚 scrypt 哈希存储用一枚废一枚）+ Passkey（`@simplewebauthn`；二次因子与无密码主登录双角色；signCount 回退=克隆检测）；登录状态机 `password_ok → mfa_pending（低权，限绑定/恢复页）→ 完全会话`；敏感操作步升认证（重验一次因子，5 分钟 TTL 复用）；策略：admin 强制不可关、会员默认强制、普通可选；OIDC 账号 MFA 委托 IdP。

**注册要点**：注册默认开放；注册/找回密码/绑定邮箱三入口全挂 PoW + 可选 Turnstile（后台填 key 即启用，默认 PoW 兜底，内网可离线）；验证码通道抽象（SMTP / 阿里云或腾讯云 SMS 选一首发）；验证码 6 位 5 分钟有效、同通道 60s 限 1 条 + 24h 上限（**短信轰炸 = 刷穿短信费，限发硬要求**）、哈希存储单次有效；每个账号自动分配唯一邀请码，成功邀请注册默认奖励属主 100 积分，管理员可停用奖励而不阻止注册；同 IP 24h ≤ 5 号；首账号自动 admin；全事件审计。

## 六、生态：.awpk 用户扩展体系（G 域）

用户上传 **AWPK**（ZIP 容器，文件扩展名必须为 `.awpk`；内容为 `manifest.json` + 静态 HTML 或 Python `mod.py`），遵循本技能出入参规范。服务端校验扩展名、ZIP 结构和 manifest，不要求包签名或发布者公钥登记；`.asp-app` 与通用 `.zip` 不作兼容。用户首次上传时按有效订阅的“可创建应用”额度检查托管应用总数（私有与公开均计入），更新已有应用不增加名额；通过校验后应用立即安装为**私有**，用户可自行试运行并发布为公开，公开发布不限制数量，无管理员审核队列。

- **更新版本号**：Agent 重新生成同一应用的更新包时必须提高 `manifest.version`，至少递增 PATCH；先查当前包/历史交付，无法确认时询问用户。服务端不负责自动递增或拒绝重复版本号，交付说明须列出旧版到新版。

- manifest 能力声明：`capabilities`（llm/db/storage）+ `network`（**出站域名白名单**）+ `runtime`（**invoked 按调用 | persistent 持久服务**）+ `env`（环境变量/机密声明，§9.5）。LLM 按 `llm` 声明强制门控；db/storage 当前不做逐项运行时门控；上传无需签名
- HTML 包：门户托管静态内容，通过应用独立 origin 访问；可使用本 origin 浏览器存储，不得访问门户会话或 DOM
- Python 包：沙箱子进程。invoked = 每次调用新进程执行后销毁；persistent = 长驻进程提供网页/HTTP API，经应用独立 origin 反代。默认 invoked 超时 30 秒、全局并发 8/队列 64；persistent 默认最多 12 个进程、空闲 300 秒回收、最多重启 3 次。当前无 per-app CPU/内存硬限额，网络守卫是 Python 层纵深防御而非硬隔离
- **网络出口 = 平台出站代理**：SDK 通道逐跳核对 manifest 域名白名单及 DNS/IP；默认拒绝私网/保留地址，可由管理员精确 allowlist 放行内网目标（链路本地除外）。runner Python socket guard 只作纵深防御，不是硬安全边界
- **SDK 接口**：`llm.chat()`（走 LLM 网关；有效平台身份按平台账号归因，应用自有账号不会自动映射为平台计费身份）；`db.*`（每包独立 SQLite，execute/query + `?` 参数；当前无数据库硬配额）；`storage.*`（每包独立配额，默认总量 10 MiB）；`http.fetch()`（仅 GET，经白名单代理）；`log`
- 上传约束：JSON body ≤15 MiB；ZIP 解压 ≤2,000 项/100 MiB；requirements ≤32 且仅 wheel；env ≤16 项（值 ≤8,192 字符、default ≤4,096、pattern ≤200）；egress GET 15 秒、最多 5 次重定向、响应 ≤500,000 字符、自定义头 ≤16 项
- 生命周期：用户或管理员上传→校验→立即私有可用→用户可自行发布公开；不要求签名或公钥信任配置；举报/下架/全事件审计
- 第一版刻意收窄：不做跨包调用、任意 SQL；**pip 依赖 2026-09-22 起走声明制**（manifest.requirements，上传时 `pip install --only-binary=:all: --target .deps` 装入应用数据目录、沙箱 PYTHONPATH 前置、失败=上传被拒；PIP_INDEX_URL 设置支持镜像；native/FPK start.sh 启动自检补装预置 flask，docker 镜像本就预装 py3-flask）

## 七、管理面板体验（P0 验收硬指标）

office-tool 后台丑且交互差是已知痛点；新面板七条要求：① 视觉与门户同源（共用主题 CSS variables）；② 首次配置 checklist 向导（域名证书→管理员密码→注册策略→接第一个应用）；③ 配置项一句话说明 +「默认值即可跑」标注 + 高级项折叠；④ 危险操作防呆（告知后果+输入确认）；⑤ 状态仪表卡（证书/上游健康/代理连通 绿黄红）；⑥ 移动端可看状态做紧急操作；⑦ 保存即生效 + 测试按钮直接给结果。
**验收**：找 1–2 个没用过 office-tool 的真实用户，无文档走通「装好→配好→发布」，卡壳处整改。

## 八、FPK 要点（文档镜像：github.com/ckcoding/fnnas-docs，每晚同步官方）

统一网关（gatewayPrefix `/app/{appname}` + gatewaySocket Unix socket，NAS 登录态校验后转发附用户 Header，支持 WS）；依赖声明 `install_dep_apps`（database/cache/redis/minio，右到左安装）；运行时包 python312/nodejs_v22/java-21（`/var/apps/<rt>/target/bin` 加 PATH）；TRIM_* 环境变量族（TRIM_APPDEST/TRIM_PKGVAR 等）。**本包采用原生形态 + 端口主入口（2026-09 定稿，官方 fnpack 必检清单全过）**：manifest（INI 无扩展名，省略 service_port + checkport=false）+ config/{privilege,resource} + cmd/ 九脚本 + wizard/（wizard_port 端口）+ ICON.PNG/ICON_256.PNG（64/256）；载荷 = deploy/native 自包含包；入口 = 桌面图标 type=url 端口快捷方式（不经统一网关）；服务端 GATEWAY_PREFIX/SOCKET_PATH 前缀与 socket 能力保留休眠（`apps/server/src/lib/gatewayPrefix.ts`）；细节与取舍见 `deploy/fpk/README.md`。

## 九、沙箱日志收口与调试沙箱（平台侧约定，v2.1 新增；与 app-develop 规范 v0.2 §3.5/§3.6/§七 配套）

### 9.1 日志管线（G2/G5 配套，开发日志与运行日志统一收口 portal）

- **沙箱进程唯一日志出口 = stderr 上的结构化 JSON lines**（`{ts, level, pkg, run_id, msg, ...}`）。SDK 注入的 logging handler 负责：级别格式化、**脱敏过滤**（key/token 打码）、**条数/字节限额**（超限截断并在记录里标 `truncated: true`）。
- **supervisor（沙箱父进程）捕获 stderr → 汇入平台运行记录表**（谁/哪个包/运行 ID/耗时/LLM token/日志）。invoked 与 persistent 同一条管线；persistent 的运行粒度 = 每次请求上下文。
- **级别保留策略**：`DEBUG` 仅本地调试与试运行保留；线上保留 `INFO+`，按保留期定时清理（复用 audit.js 的分批清理模式）。
- 个人端「工具运行记录」页、管理端应用试运行日志、生态日志查询，**都读这一份记录**，不另设日志通道。
- **禁止 `print()`** 的原因要写进规范（已写）：stdout 在 invoked 模式是结构化出参协议载体。

### 9.2 调试沙箱一致性铁律

- `packages/aap-sdk` 与平台沙箱运行时**共享同一实现代码路径**（同一镜像、同一执行器；invoked/persistent 双模式同路径）。**本地调试 = 同一执行器 + `AAP_DEBUG=1` 开详细日志 + 本地资源映射**（SQLite 文件 / 目录存储 / mock LLM）。
- **禁止另写并行模拟器**——行为漂移比没有调试工具更糟。mock 实现与生产实现必须对照同一测试集验证网络白名单、超时、JSON 校验、进程即毁；本地能力检查不代表生产服务端对 db/storage 有强制能力闸。
- 调试模式下全量详细日志：每次 `aap.*` 调用（入参脱敏后/出参摘要/耗时）、SQL 与参数、storage 操作与配额水位、HTTP 代理逐请求（URL/**白名单判定**/状态/耗时）、LLM usage、进程生命周期（启动/超时/退出码）。
- `aap-dev` CLI（**当前实装**：`run` + `--reset` + mock LLM；`serve` / `--llm real` / `--submit` 随 M4 完整版提供，勿在文档中当作已可用）。
- **与线上一致的边界刻意保留**：白名单在本地照常强制、超时/JSON 校验/进程即毁语义相同；本地能力检查不应被视作生产服务端的安全边界，生产端当前只有 `llm` 能力有强制网关校验。

### 9.3 门户 chrome 注入（兼容入口）

- **旧路径/外壳兼容入口**：可能由门户外壳显示 chrome；不得把它当作新应用子域名上的平台契约。
- **HTML 静态应用**：使用独立应用 origin，不在门户 shell iframe 内；不得依赖门户 chrome 注入或门户 `postMessage` 桥。
- **persistent 应用**：同样直接运行在应用独立 origin；不应依赖门户悬浮条、脚本或 `postMessage` 桥，可自行实现应用用户导航。
- 包作者侧约定（独立应用 origin 的 Cookie 与浏览器存储边界）在 app-develop 规范 §3.6。

### 9.4 `aap` 接口冻结

- `aap` 对象接口面（`llm` / `db` / `storage` / `http` / `log`）以 app-develop 规范 §三 为准，**开发期即冻结**；新增能力必须走规范升版 + manifest 能力字段同步 + 管理端包预览同步，不允许运行时动态扩面。
- 实装顺序：W0（本节）定契约 → M4 实装 `packages/aap-sdk`；接口冻结后 M2/M3 的 LLM 网关计量、配额预检对 SDK 透明（SDK 只见 `aap.llm.chat` 语义）。

### 9.5 应用环境变量 / 机密（G6，v2.3 新增；与 app-develop 规范 v0.2.2 §1.1 配套）

包需要外部配置（第三方 API key 等）时的平台侧机制，**密钥零落地进包**。设计要点：

- **声明**：manifest `env`（`parseEnvSpec`），变量名 → `{required(默认 true), secret, pattern, default, description}`，支持「"名": "描述"」速记；保留名黑名单（`AAP_*`、`PORT`、`PATH`、`HTTP_PROXY` 族、`PYTHON*`、`SSL_CERT_*`、`SANDBOX_*`、`NODE_OPTIONS`）防劫持平台注入面；上限 16 个，非法声明上传失败。
- **存储与保密**：值一律 AES-256-GCM 加密落盘（`app_env_vars` 表），secret 只写不读（仅回尾 4 位 hint）；审计只记变量名不记值。
- **注入与拦截**：`baseEnv()` 在 invoked/persistent 沙箱启动时统一注入（persistent 须在 mod.py 执行前挂 `builtins.aap`——顶层阻塞在 `app.run()` 后注入永不生效）；必填缺配 invoked 执行 400 ENV_MISSING / persistent 拉起 503。
- **配套 egress**：`aap.http.fetch(url, timeout, headers)` 支持自定义请求头（逐跳与托管头剥除、上游状态码透传），与规范 §3.4 接口面同步。
- **LLM 模型配置约定**：声明 `llm` 的新包必须声明必填 `env.MODEL`，由应用使用者在门户可用模型目录中选择；新包统一使用 `MODEL`，门户兼容既有 `OCR_MODEL` / `MODEL_NAME` 等变量名。开发 Agent 应按任务建议：简单短文本任务优先低延迟、低成本且指令遵循稳定的模型；长文档或多步推理选上下文与推理能力足够的模型；结构化输出选格式遵循可靠的模型，并建议用代表性输入试用。

表结构 / 配置 API / 管理入口 / egress 实现细节见 `docs/DEVELOPMENT.md` §9（单一来源，勿在此重复维护）。


## 十、实现状态快照（v2.2，2026-09）

M1–M4 核心已交付；测试数与实装明细以 `docs/DEVELOPMENT.md` 为准（本节只记里程碑快照，不放易过期的用例计数）。

- **已实装**：路径反代全套（§二）、WS 双通道、passUser 自动签发/注入、自动 HTTPS（PEM 热替换 + ACME HTTP-01 + 续期）、本地账号+注册（验证码 SMTP/Resend/日志兜底 + 邀请码 + Turnstile 接口）、MFA（TOTP/Passkey/恢复码/步升/状态机）、用户中心四区、管理后台（总览/站点设置/应用管理/用户与注册/安全/通知通道/证书/LLM 网关/运营 九个功能域选项卡 + 左侧竖向首配向导）、Docker/FPK/CI(ghcr 多架构+FPK Release)、OIDC SSO（PKCE）
- **M2 LLM 网关**：`/v1/chat/completions`（流式透传+末帧 usage 捕获）、`/v1/models` 聚合；凭据 `aapk_*`（SHA-256 存储、可吊销、按凭据限流）；路由 priority+加权 failover；`llm_ledger` append-only 账本 + `llm_balance_cache` 预检（402）+ 事后校正；结算循环每分钟对账；凭据对全部包上传即自动签发（AAP_TOKEN 同时是 egress 出站凭据；tokenEnc 加密保管，`getAppLlmProvision` 供 M4 运行时注入），LLM 花费面由 `appLlmAllowed` 按 manifest.capabilities 在 `/v1` 直连与 `/api/aap/llm/chat` 双侧闸（审计 F1：签发广度与能力闸解耦，勿改回「未声明不签发」——会断非 llm 包出站）；应用删除连带吊销全部网关凭据
- **M3 计费**：功能订阅套餐（人民币/美元人工确认；积分独立于 Token，事务扣分后立即开通；开通入分组/续费顺延/到期自动降级出组）；注册赠送积分；额度充值与**卡券码**（AAP-XXXX-XXXX-XXXX，原子兑换防双花，可作废/设有效期）；运营面板（套餐 CRUD/订单确认/余额消耗排行/应用热度/成本毛利）；manual 支付渠道首发（adapter 接口可扩）
- **可见性模型（P）**：public / login（站内共享）/ private（仅归属者，用户自建默认，门户对他人隐藏）；旧受限应用迁移为 login。用户分组用于订阅等级与权益管理，与应用可见范围分开管理。
- **通知通道**：MAIL_PROVIDER = smtp | resend（Resend 仅需 API Key，from 留空用沙箱发件人）；日志兜底（内网离线）；`SHOW_TOPUP_PANEL` / `SHOW_ORDERS_PANEL` 分别控制用户中心额度充值与订单卡片，默认隐藏
- **门户页面元素**：兼容路径/门户外壳可显示 portal chrome；新的独立应用 origin 不注入门户脚本或统一悬浮条，应用不得依赖平台导航注入
- **管理后台体验（P）**：九个功能域选项卡（总览/站点设置/应用管理/用户与注册/安全/通知通道/证书/LLM 网关/运营）+ 左侧竖向首配向导（可收起，完成自动隐藏）；设置项控件化（choiceLabels 下拉/bool 开关/int 数字框/取色器/密码+审计查看）与 `exclusiveOf` 互斥渲染（SMTP vs Resend）；展示降噪（短标签+tooltip 收纳描述与配置键，仅 defaultsWork=false 显示「需配置」）；密钥查看端点 `GET /api/admin/secrets/:key`（记审计）
- **LLM 凭据签发已收敛为自动**：包上传即自动签发运行时凭据（tokenEnc 加密保管，运行时按 appId 注入；未声明 llm 的包凭据仅服务 egress，LLM 调用被网关能力闸 403），管理端手动签发表单已移除，仅保留凭据列表与吊销；用户调额入口在运营面板
- **更名记录**：X-Office-*→X-AAP-*；WEBUI_SIGN_SECRET→AAP_SIGN_SECRET（settings 表，首启随机/env 初值，管理端高级项可查看需审计）；邮件通道→通知通道；会员→功能订阅
- **关键新增配置**：RATE_LLM_PER_MIN / TOPUP_TOKENS_PER_FEN / REGISTRATION_POINTS_GIFT / SHOW_TOPUP_PANEL / SHOW_ORDERS_PANEL / MFA_STEPUP_TTL / CODE_SEND_DAILY_LIMIT / DELETION_COOLDOWN_DAYS / APP_ALLOW_PUBLIC_UPSTREAM / ACME_* / HTTPS_REDIRECT / MAIL_PROVIDER / RESEND_*
- **M4 已交付（G2–G5 核心）**：Python 沙箱运行时（runner + aap 对象 llm/db/storage/http/log；invoked stdin/stdout JSON + 30s 强杀；persistent 拉起+空闲 5 分钟回收+崩溃重启≤3 次+反代纳管）；出站经 `/api/aap/egress`（manifest 白名单逐跳核验及 DNS/IP 检查；管理员可配置精确内网 allowlist，链路本地始终拒绝）；`/api/aap/llm/chat` 平台代理（签名归因到运行用户 + `llm` 能力声明校验）；包通过 ZIP/manifest 校验后无需签名即可私有可用，用户可按订阅额度自行公开；运行记录 `app_runs` + 审计
- **M4 剩余**：aap-dev 完整版（serve 子命令 / real LLM / --submit 回传）、容器 ns/cgroups 硬隔离叠加（persistent WS upgrade 透传已实装，见上）
- **ACME 已真实环境验证 ✅**：真实域名生产签发 → 8443 热启动 → HTTPS 受信；续期循环运行中。**待办（环境）**：OIDC 真实 IdP 联调；FPK 真机；E2 真人走查
