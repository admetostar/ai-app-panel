---
name: awpk-app-develop
description: "当用户要求开发、打包或重构 .awpk 应用包时使用：manifest 契约、aap.* 能力接口、沙箱纪律与交付自检。"
---

# app-develop.skill.md

> ai-app-panel 应用开发规范 · 供开发 Agent 使用
> 版本 v0.3.8（2026-11）· 配套平台 PRD v0.3+
>
> **v0.3.8 变更**：明确 passUser 注入应用属主身份（匿名路由也适用）；`account` 路由仍注入已鉴权的实际访问者身份，且任何身份头都不改变 LLM 费用按应用属主归属的规则。
>
> **v0.3.7 变更**：补充属主可选配置应用域名别名的说明；别名只改变访问入口，不改变可见范围、匿名路由权限或费用归属。
>
> **v0.3.6 变更**：新增 AWPK 路由级匿名读写和账号身份声明；匿名权限与可见范围分离；明确 LLM 用量按属主计费、与请求身份分离。
>
> **v0.3.5 变更**：新增大文件媒体异步 LLM 契约：`upload_media`、`chat_async`、`get_chat_job`，明确图片/视频限制、状态阶段、媒体路由格式及 10 分钟身份有效期边界。
>
> **v0.3.4 变更**：强化 LLM 用户身份归因要求，补充单线程与后台线程/线程池的身份头捕获和传递方法；增加按任务类型选择 `MODEL` 的建议。
>
> **v0.3.3 变更**：明确 AWPK 更新的 `manifest.version` 递增规则；每次生成用于替换既有应用的新包必须递增版本，并在交付前核对旧版本。
>
> **v0.3.2 变更**：声明 `llm` 能力的应用统一使用必填 `env.MODEL`，从门户模型目录选择并显式传给 `aap.llm.chat`；历史模型变量名继续兼容。
>
> **v0.3.2 变更**：声明 `llm` 能力的应用统一使用必填 `env.MODEL`，从门户模型目录选择并显式传给 `aap.llm.chat`；历史模型变量名继续兼容。
>
> **v0.3.1 变更**：补充未配置 `SITE_DOMAIN` 时的本地路径沙箱回退；需验证应用独立 origin 与浏览器存储时，应配置应用域名。
>
> **v0.3.0 变更**：新包统一为 `.awpk`（ZIP 容器 + `manifest.json`）；不再接受旧 `.asp-app` 或通用 `.zip` 扩展名。明确上传、校验、依赖安装与可运行约束，并同步能力清单、资源限制及独立应用 origin 会话边界。
>
> **v0.2.8 变更**：`.awpk` 上传无需签名或登记公钥；普通用户与管理员均可即传即用，上传后默认私有，用户可自行发布为公开。
>
> **v0.2.6 变更**：manifest 新增 `requirements` 字段（§1.2 pip 依赖声明）——超出标准库+平台预置框架的第三方库在 manifest 列出，**上传时平台自动 `pip install`**（只装 wheel）到应用私有目录，沙箱内直接 import，失败=上传被拒；版本更新不再声明的依赖自动清除。新平台增设「pip 索引源」设置（PIP_INDEX_URL，国内镜像）。native/FPK 形态启动时自检补装预置框架 flask（此前仅 docker 镜像预装，宿主缺 flask 时 persistent 包静默 503 崩溃循环——llm-proofread 实测案例）。§一/§五 同步。
>
> **v0.2.5 变更**：passUser 应用身份验签密钥自动下发——勾选「注入用户身份」的 .aap 包，沙箱环境变量自动注入 `AAP_SIGN_SECRET`（平台全局身份签名密钥；`AAP_` 保留名，manifest.env 不可声明覆盖），persistent 应用可直接本地验签 `x-aap-identity` 头按用户隔离数据（§二 persistent、§五）；后台轮换密钥或切换 passUser 开关会自动停起 persistent 进程，改完即生效。上游（external）应用接入时在管理后台应用表单复制 `AAP_SIGN_SECRET` 自行配置。
>
> **v0.2.4 变更**：补 skill frontmatter（可安装自动触发）；原 §五硬性约束与 §七自检清单**合并为单一清单**（同一规则不再多处复述）；原 §八 aap-dev 按当前实装收窄（run + mock；serve/--llm real/--submit 随平台 M4 提供，勿当作已可用）；坑清单精简为带症状增量的条目；全文重编号（原§八→§七、原§九→§八）。
>
> **v0.2.3 变更**：新增 §3.7 沙箱前端纪律（禁 localStorage/密钥收集、剪贴板降级等）；§二 persistent 增加**状态纪律**（进程会被空闲回收/重启，跨请求状态一律落 aap.db）；新增 §九 实战案例与坑清单（ip-analyzer 移植 / llm-proofread 重构设计）。§五、§七 同步。
>
> **v0.2.2 变更**：manifest 新增 `env` 字段（§1.1 环境变量 / 机密声明）——需要 API key 等配置的包不再硬编码，改为 manifest 声明变量名（必填/可选、是否密钥、格式校验、默认值），上传后由归属者/管理员在门户填值（密钥 AES-256-GCM 加密存储、界面只写不读），沙箱启动时自动注入为进程环境变量（`os.environ` 直接读）。§3.4 `aap.http.fetch` 支持 `headers` 自定义请求头并透传上游状态码（鉴权 API 场景）。§五 硬性约束与 §七 自检清单同步。
>
> **v0.2.1 状态记录**：HTML 包门户托管已上线；Python 沙箱运行时（invoked / persistent）已实装。包上传自动配置网关凭据，LLM 能力闸在网关侧强制。页面 chrome 曾作为路径/iframe 入口能力提供；v0.2.9 起新应用统一使用独立 origin，不再依赖该 chrome。
>
> **v0.2 变更**：新增 §3.5 日志规范（开发/运行日志统一收口 portal）、§3.6 统一页面元素（返回个人中心/退出登录按钮）、§八 本地调试沙箱（aap-dev）；§五 硬性约束与 §七 自检清单同步。

---

## 你是谁、要做什么

你正在为 **ai-app-panel** 开发一个新应用。用户会告诉你需求设想；你的产出是一个符合本规范的 **`.awpk` 包**（ZIP 文件）。打包后无需签名或联系管理员登记密钥，用户可以直接上传。

`.awpk` 是 **ai-app-panel** 的应用包格式。包内只有两种形态，按需求二选一：

| 形态 | 适合 | 包内容 |
|---|---|---|
| **HTML 工具** | 纯前端：格式转换、计算器、文本处理（可自带 JS） | `manifest.json` + `index.html` + 静态资源 |
| **Python 应用** | 需要 LLM / 数据库 / 存储 / 对外提供网页或 API | `manifest.json` + `mod.py`（单文件） |

---

## 一、manifest.json（必读，能力全靠它声明）

```jsonc
{
  "name": "stock-summary",          // 包标识：小写字母数字连字符，全局唯一
  "display_name": "股票摘要助手",
  "version": "1.0.0",
  "type": "python",                  // "html" | "python"
  "entry": "mod.py",                 // python 必填；html 固定 index.html；仅限包内相对路径（含 ../ 或绝对路径上传即拒）
  "description": "输入股票代码，生成中文投资摘要",
  "author": "someone",
  "runtime": "invoked",              // "invoked" 按调用 | "persistent" 持久服务（仅 python）
  "capabilities": ["llm", "db"],     // 按需声明：llm / db / storage，不用的不要写
  "network": [                       // 出站域名白名单（无需联网则留空数组）
    "api.example-data.com"
  ],
  "routes": [                        // v0.3.6：按路径和方法声明访问级别；未声明路由不向匿名开放
    { "path": "/api/items", "methods": ["GET"], "access": "anonymous_read" },
    { "path": "/api/items", "methods": ["POST"], "access": "anonymous_write" },
    { "path": "/api/admin/*", "methods": ["GET", "POST"], "access": "account" }
  ],
  "env": {                           // 环境变量/机密声明（v0.2.2，见 §1.1；无需配置则省略）
    "ABUSEIPDB_API_KEY": { "required": true, "secret": true, "pattern": "^[a-f0-9]{80}$", "description": "AbuseIPDB 密钥" },
    "MAX_CONCURRENCY": { "required": false, "default": "4", "description": "并发上限" }
  },
  "requirements": ["flask>=3.0"],    // pip 依赖声明（v0.2.6，见 §1.2；只作标准库+预置框架则省略）
  "route": "stock-summary"           // legacy field; 新入口使用应用独立 origin 的根路径
}
```

**应用版本号（强制）**：
- `manifest.version` 使用 `MAJOR.MINOR.PATCH` 三段数字格式（例如 `1.2.3`）；新应用可从 `1.0.0` 开始。
- 每次重新生成并交付用于更新同一应用的 `.awpk`，都必须比当前已安装/上次交付版本更高；即使只是修复、小改动或重打包，也至少递增 PATCH（`1.2.3` → `1.2.4`）。新增且向后兼容的功能递增 MINOR；不兼容变更递增 MAJOR，并将较低位归零。
- 开始修改前先检查用户提供的现有 `manifest.json`、已有包或对话/项目记录，确定该应用当前版本；不能因为新一轮任务或上下文变化重置为 `1.0.0`，也不能重复使用已发布版本。若无法确认当前版本，先向用户询问，不能猜测。
- 每次打包后再次核对新旧版本，并在交付说明中写明版本变化（例如 `1.2.3 → 1.2.4`）。版本号是作者侧更新契约；不要假设平台会自动递增或拒绝重复版本。

**铁律**：
1. `capabilities` 和 `network` 是应用的能力申请与出网边界声明；只声明应用实际需要的能力。上传不要求签名，修改后重新上传/更新。
2. Agent 必须按本规范的接受清单和限制清单实现；不得自行增加平台 API、系统权限、网络出口或依赖安装途径。
3. `runtime: "persistent"` 会常驻占用资源：没有持续服务需求的（哪怕要调 LLM）一律用 `invoked`。

### 1.0.2 匿名访问路由（v0.3.6）

应用门户可见范围（公开 / 站内 / 仅自己）与匿名访问权限是完全独立的设置。属主在应用设置中单独选择“关闭、只读、读写”；新建应用默认为关闭。公开可见不代表自动开放匿名访问，站内或仅自己应用也可以通过分享链接开放所声明的匿名路由，但仍不会因此出现在额外的门户列表或改变克隆规则。

属主可在应用设置中为应用配置可选的自定义访问别名。配置后，应用也可通过 `https://<别名>.<SITE_DOMAIN>/` 访问；留空时仍使用应用 ID。别名只改变入口地址，不改变应用可见范围、匿名访问权限、克隆规则或 LLM 费用归属；应用创建时别名为空。应用 ID 与别名是不同 origin，浏览器本地存储和 host-only Cookie 不共享，建议对外固定使用其中一个入口。

AWPK 必须在 `manifest.routes` 中逐条声明匿名可访问或需要账号身份的应用路由：

| `access` | 含义 |
|---|---|
| `anonymous_read` | 只允许 `GET`、`HEAD`、`OPTIONS`；仅在属主应用级权限至少为“只读”时允许匿名请求 |
| `anonymous_write` | 允许属主应用级权限为“读写”时匿名请求；只读设置会拒绝 |
| `account` | 必须有完整平台账号会话；网关为该请求签发 `X-AAP-Identity` 与签名头，即使应用没有启用通用 `passUser` |

`path` 是以 `/` 开头的应用路径，可用末尾 `*` 匹配路径前缀；`methods` 使用大写 HTTP 方法。WebSocket 使用方法 `WS`，属于写操作，只能声明为 `anonymous_write` 或 `account`。重叠路径由更具体的规则优先。没有匹配声明的路由一律拒绝匿名请求；账号访问仍按可见范围原有登录规则判断。不要把会修改状态、发起付费调用或暴露敏感信息的处理器标为 `anonymous_read`。此声明是平台网关实际强制的边界，不能只在前端隐藏按钮。

`passUser` 是属主对应用身份注入的单独开关：开启后，普通应用路由（包括获准匿名访问的路由）收到的签名身份代表**应用当前属主**，不代表请求访问者；关闭时这些路由不注入身份。`account` 路由优先要求完整账号会话，并始终注入**实际访问者**身份，即使 `passUser` 已开启。匿名权限与可见范围仍独立控制能否访问；身份注入不会放宽访问控制。

声明 `capabilities` 包含 `llm` 的应用，无论可见范围、访问者或是否匿名，所有 LLM 用量始终归应用当前属主账号；克隆副本以克隆者为新属主，其用量归克隆者。匿名应用必须由属主承担相应费用和额度限制。

### 1.0 Agent 边界清单（强制）

**可接受的能力，仅限下列清单：**

| 需求 | 唯一允许的接入方式 | 约束 |
|---|---|---|
| 大模型 | `aap.llm.chat`；`capabilities` 必须声明 `llm` | 走平台网关；所有用量始终按应用当前属主计费，克隆副本归克隆属主，身份头不改变费用归属。需识别登录访问者时将路由声明为 `account`；匿名路由不传递访问者身份，开启 `passUser` 时收到的是属主身份。不得自带模型 API key、直连模型服务或绕过网关 `/v1` |
| 应用私有结构化数据 | `aap.db.execute/query`；声明 `db` | 只访问本应用自己的 SQLite；SQL 参数使用 `?`；不得连平台数据库或其他应用数据库 |
| 应用私有文件 | `aap.storage.put/get/delete/list`；声明 `storage` | 只在本应用配额目录内操作；不得把主机目录当文件存储 |
| 第三方 HTTP GET | `aap.http.fetch` + `network` 白名单 | 仅 HTTP/HTTPS GET；域名、DNS 解析结果、每次重定向都由平台代理复核 |
| 配置和第三方凭据 | `manifest.env` + 门户环境变量 | 服务端读取；密钥标记 `secret`；不得写入源码、HTML、日志或让用户在应用前端输入平台/第三方密钥 |
| 运行诊断 | `aap.log` / Python `logging` | 只记脱敏后的必要事件；不得将日志当业务结果或密钥存储 |
| 用户自己的登录/浏览器会话 | 应用独立 origin 上由应用自行实现 | 可用本应用 origin 的 `localStorage`、`sessionStorage`、host-only Cookie；不得读取、复制或依赖门户会话/身份 Cookie |

`aap.*` SDK 只注入 Python 包；静态 HTML 包没有这些接口，前端应调用应用自己的后端，不得直接调用平台内部 API，也不得通过浏览器直接请求第三方服务来绕过 `manifest.network`。`network` 默认空；只添加代码确实调用的域名，使用主机名或平台支持的 `*.example.com` 通配形式，不写 URL、端口、路径或 IP。平台当前没有限制白名单条目数量，最小授权原则仍适用。

包上传不要求代码签名，也不代表平台已审计/信任包代码；公开仅代表可见性，不是安全背书。Agent 应将第三方依赖和包内代码视为不可信输入，避免保存不必要的敏感数据。

**禁止清单（Agent 不得生成此类设计或代码）：**

- 未列入上表的平台内部 API、门户管理接口、数据库连接串、平台会话、内部令牌或文件路径；不得猜测 SDK 之外的 `aap.*` 接口。
- Python 直接网络出口（`socket`、原始 HTTP 客户端、DNS 查询、Unix socket、`subprocess`/`os.system` 建立网络隧道）；所有第三方出站只能用 `aap.http.fetch`。即使某运行环境能绕过 Python 网络守卫，也属于违规，不能作为实现方案。
- 未在 manifest 声明的第三方域名；IP 字面量、localhost、`.local`、`.internal`、私网/保留地址（管理员明确配置的内网白名单除外，链路本地/云元数据地址始终禁止）。
- 运行时 `pip install`、下载/执行任意代码、动态安装系统包、启动额外后台进程或自选监听端口。
- 读写包目录/主机文件系统之外的文件，访问其他应用目录，读取平台环境变量或尝试覆盖 `AAP_*`、`PORT` 等保留变量。
- 自行实现平台统一账号/MFA/门户登录；如需求是应用自己的用户体系，只能在应用独立 origin 内实现，并使用自己的应用数据和 host-only Cookie。
- 声称平台有未在本规范明确列出的 CPU、内存、数据库容量、每文件容量、调用次数或 LLM token 保证。没有明确数字的资源不等于无限资源。

**强制实现状态说明：**当前服务端对 manifest `llm` 能力在 LLM 网关强制校验；`db`、`storage` 是声明纪律，但 SDK 目前不会据此逐项阻断调用。Agent 仍必须按需声明，不能把“未声明时可能可调用”当作允许越界的理由。Python 网络守卫是纵深防御，不是操作系统级安全边界；应用必须遵守上述禁止清单。

### 1.0.1 当前资源与容量边界

以下为当前实现值，不是资源 SLA；管理员设置、部署形态和主机容量可能进一步收紧。只写代码实际执行的上限，不要在应用说明中承诺平台未提供的配额。

| 资源/操作 | 当前边界 | Agent 实现要求 |
|---|---|---|
| `.awpk` 上传 | 请求 JSON body 上限 15 MiB；ZIP 解压最多 2,000 个条目、累计解压最多 100 MiB | 控制包体和静态资源；不得把解压上限当作应用运行存储额度 |
| Python 依赖 | 最多 32 条；仅接受包名/版本约束，平台仅安装 wheel | 精简依赖、固定合理版本；不支持 URL、Git、本地路径、`-r`，无 wheel 的依赖无法上传 |
| 环境变量 | 每包最多 16 项；单值最多 8,192 字符；`default` 最多 4,096 字符；`pattern` 最多 200 字符 | 只声明必要变量；不要把大配置/数据塞进环境变量 |
| invoked | 单次执行 30 秒；全局并发默认 8（管理员可调），等待队列最多 64；stdout/stderr 捕获各最多 512 KiB，运行记录返回日志尾部最多 8,000 字符 | 短任务、有限输入/输出；长任务需改为持久服务或拆分工作，不得依赖排队一定成功 |
| persistent | 全局最多 12 个进程（管理员可调）；空闲默认 300 秒回收，配置最小 30 秒；崩溃自动重启最多 3 次 | 服务需快速启动、可安全重启；持久状态写入 `aap.db`/`aap.storage`，不得依赖进程内存 |
| `aap.storage` | 每应用总量默认 10 MiB（SDK 默认值）；当前无单文件独立上限 | 应用端按总配额控制上传和替换；不得将其描述为可无限扩容 |
| `aap.db` | 每应用独立 SQLite；当前没有 SDK 层数据库大小/行数配额 | 只保存必要结构化数据、分页查询、避免大 blob；数据库无硬配额不代表可无限使用 |
| `aap.http.fetch` | 只做 GET；单次平台代理超时 15 秒；最多跟进 5 次重定向；响应文本最多返回 500,000 字符；自定义头最多 16 项、名称最多 64 字符、值最多 4,096 字符 | 只取所需字段；处理非 2xx 状态和超时；不得用 GET 隧道提交数据 |
| LLM | 默认模型生成上限由管理员设置 `LLM_SANDBOX_MAX_TOKENS` 控制；当前默认 0 表示不设平台级上限；调用按用户/应用计量并受余额预检约束 | 每次调用显式设合理 `max_tokens`，限制上下文和重试；不得承诺无限免费调用 |
| CPU / 内存 / 总应用磁盘 | 当前没有 per-app CPU/内存硬限额或 `aap.db` 硬配额；部署宿主机容量是最终边界 | 避免无界循环、大批量载入、深度/高并发请求；不要宣称有未实现的硬隔离 |

普通用户每日上传次数由平台设置控制（默认 20）；应用目录剩余磁盘低于默认 512 MiB 时拒绝新包上传。它们是上传保护，不是应用可占用磁盘额度。

### 1.1 env——环境变量 / 机密声明（v0.2.2）

需要外部配置（第三方 API key、阈值……）时，**在 manifest `env` 里声明，不要写死在代码里，更不要自己要求用户把 key 交给你**：

```jsonc
"env": {
  "变量名": "描述",                                    // 速记：= required 必填
  "变量名": { "required": true, "secret": true, "pattern": "^…$", "default": "…", "description": "…" }
}
```

**LLM 应用模型约定**：声明 `capabilities` 包含 `llm` 的应用必须在 `env` 中声明必填的 `MODEL`（`{"required": true}`），并通过 `os.environ["MODEL"]` 读取后显式传给 `aap.llm.chat(..., model=model)`。模型名由应用使用者在门户可用模型目录中选择；`MODEL` 不要声明为机密变量，不需要填写专属 `description`，也不要设置默认模型。向使用者给出清晰的选择建议：短文本分类、抽取、改写等简单任务优先选择响应快、成本较低且指令遵循稳定的模型；长文档分析或多步推理选择上下文长度和推理能力足够的模型；要求结构化输出时选择 JSON/格式遵循表现可靠的模型，并用代表性输入验证输出。最终以门户当前可用模型目录为准，结合质量、延迟和成本试用，不要假定目录中存在未展示的模型。现有包中的 `OCR_MODEL`、`MODEL_NAME` 等历史命名仍受门户模型选择器兼容，但新包统一使用 `MODEL`。

| 字段 | 说明 |
|---|---|
| `required` | 默认 `true`。必填变量未配置时，平台**拒绝执行/拉起**并明确提示缺哪个 |
| `secret` | 默认 `false`。`true` = 机密：AES-256-GCM 加密落盘，门户界面只写不读（仅显示尾 4 位提示） |
| `pattern` | 可选，简单格式校验正则（保存配置时执行；自行带 `^` `$` 锚点） |
| `default` | 可选，未配置时注入的默认值（**机密变量不允许 default**；值须为字符串） |
| `description` | 展示在配置界面，告诉填写者这是什么 |

**行为与纪律**：
- 值由**归属者/管理员**上传后在门户「环境变量」里填（用户中心·我的应用 / 管理后台·应用管理都有入口）；沙箱每次启动时注入为进程环境变量，代码里直接 `os.environ["变量名"]` 读。
- 只声明应用需要的变量：最多 16 个，变量值上限 8,192 字符；`default` 最多 4,096 字符且机密变量禁止默认值；校验正则最多 200 字符。变量名须匹配 `[A-Za-z_][A-Za-z0-9_]{0,63}`。
- `AAP_*`、`PORT`、`PATH`、`HOME`、代理变量、Python 运行变量、`SANDBOX_*` 等平台保留名不可声明。密钥只在服务端运行时读取；不得回显到 HTML/API、运行结果或日志。

### 1.2 requirements——pip 依赖声明（v0.2.6）

代码需要的第三方库（超出标准库 + 平台预置框架的部分）**在 manifest `requirements` 里声明，上传时平台自动安装**到应用私有目录，沙箱内直接 `import`，不允许任何形式的运行时自装：

```jsonc
"requirements": ["flask>=3.0", "requests==2.32.3", "beautifulsoup4"]
```

- **声明制**：与 `capabilities`/`network` 一致，依赖按声明安装；改动依赖后重新上传/更新，不需要签名。
- **写法**：标准 pip 需求串（`名称[extras] 版本约束`）；**建议带版本上限或精确版本**（不带约束 = 安装当时最新版，升级后行为可能变）。不支持 URL / 本地路径 / `-r`（上传即拒）。
- **安装时机**：上传/版本更新时平台执行 `pip install --only-binary=:all: --target <应用目录>/.deps`；**失败 = 上传被拒**，错误原样返回（网络/镜像源问题调平台「pip 索引源」设置）。
- **只装 wheel**：无预编译 wheel 的源码包（含需编译 C 扩展且平台无对应 wheel 的）装不了，上传时会明确报错——换纯 Python 等价库或联系管理员。
- 版本更新不再声明的依赖会被清掉；依赖装在应用数据目录下，平台升级/重建不影响。
- 最多 32 条依赖；依赖声明仅支持包名、extras 与版本约束，不支持 URL/Git/本地路径/requirements 文件。
- persistent 应用修改配置后会自动重启进程（下次访问生效）；invoked 天然每次生效。
- **保留名不可声明**：`AAP_*`、`PORT`、`PATH`、`HOME`、`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`、`PYTHON*`、`SSL_CERT_*`、`SANDBOX_*`、`NODE_OPTIONS` 等（平台注入面，声明即上传失败）。
- 单包最多 16 个变量；值长度 ≤ 8192 字符；日志纪律同样适用——**不要把环境变量值打进 `aap.log`**。

---

## 二、运行时模型（python）

### invoked（按调用）——默认选择

每次用户发起调用，平台**起一个全新进程**执行你的 `mod.py`，拿到返回后进程即销毁。

```
用户点工具 → 填表单提交 → 平台起进程 → 执行 handle() → 返回 JSON → 进程销毁
```

- 无状态！不要依赖进程内存保存任何东西（需要就写 db/storage）
- 单次执行 30 秒超时（勿做长任务）
- 入口函数签名见下文模板

### persistent（持久服务）——仅当你需要提供网页/API

平台拉起长驻进程并反向代理到**应用入口**：配置 `SITE_DOMAIN` 时使用 `https://<appId>.<SITE_DOMAIN>/` 独立 origin；未配置时使用门户同源 `/app/<id>/` 路径并由 opaque-origin iframe 沙箱隔离，不暴露内部服务端口。应用在自己的根路径提供服务；配置域名后旧 `/app/<id>/` 地址只作兼容跳转，不是新应用的部署基准。

- 平台负责应用访问鉴权/可见性门禁、反代、运行记录、崩溃重启与空闲回收。**不要假设门户悬浮条、用户中心链接或门户脚本会注入应用页面。**
- **状态纪律**：进程会因空闲回收、崩溃或平台重启而消失；任务、结果、草稿等跨请求状态写入 `aap.db`/`aap.storage`，不得只放进程内存。
- 应用以根路径工作，可使用普通网站的绝对路径（如 `/static/x.css`）；相对路径同样可用。兼容 `/app/<id>/` 入口时，代理会去掉旧前缀并下发 `X-Forwarded-Prefix`，但应用不应依赖这个兼容行为。
- **应用自己的会话**：配置独立 origin 后可使用 `localStorage`、`sessionStorage` 和应用 host-only Cookie；本地路径沙箱回退不提供这些独立 origin 存储能力。平台会话 Cookie 不转发到应用；应用不得读取、复制或依赖平台身份状态。应用自有 Cookie 不得设置父域 `Domain`，浏览器存储仅对该应用 origin 可见。
- **平台身份与 LLM 前置条件**：声明 `llm` 能力仍是调用 LLM 的必要条件，LLM 用量始终按当前应用属主计费，与身份头分开。开启 `passUser` 时普通路由收到的身份头代表应用属主；匿名获准访问时也可注入该属主身份。要识别平台访问者，必须将对应路由声明为 `account`；只有完整平台会话可访问该路由，网关优先注入实际访问者身份。persistent 应用在 Flask 请求处理中成对读取 `X-AAP-Identity` 与 `X-AAP-Identity-Sig` 并作为 SDK `identity` 传入；invoked 应用由平台注入对应身份环境变量。任何身份头都不会改变 LLM 费用归属。开发独立账号体系时，应用自行完成登录、会话和数据隔离。
- 监听端口由平台通过环境变量注入 `PORT`，bind 到 `127.0.0.1`，不要自行选择端口；第三方出站仍只能走 `aap.http.fetch`。

---

## 三、能力接口（SDK 存根）

平台向 `mod.py` 注入全局对象 `aap`（无需 import、无需任何密钥）。**只存在以下接口，没有别的**：

### 3.1 `aap.llm.chat(messages, **opts)` — 调用大模型

```python
import os
from flask import Flask, jsonify, request

app = Flask(__name__)

@app.post("/summarize")
def summarize():
    payload = request.headers.get("X-AAP-Identity")
    signature = request.headers.get("X-AAP-Identity-Sig")
    if not payload or not signature:
        return jsonify({"error": "未收到完整的平台用户身份，请登录后重试"}), 401
    identity = (payload, signature)
    text = request.get_json()["text"]
    resp = aap.llm.chat(
        messages=[
            {"role": "system", "content": "你是一个财务分析助手"},
            {"role": "user", "content": f"总结 {text} 的要点"},
        ],
        model=os.environ["MODEL"],  # 必填模型配置，见 §1.1
        identity=identity,         # 必须同时传入身份 payload 与签名
        temperature=0.7,            # 可选
        max_tokens=2000,             # 可选，建议写——影响预检额度预估
    )
    return jsonify({"content": resp["content"], "usage": resp["usage"]})
```

- **账号路由身份校验**：只有 manifest 声明为 `account` 的路由要求完整平台会话与有效身份。此类路由从 Flask 请求读取身份时两个头缺一不可；将 `(payload, sig)` 二元组通过 `identity=` 传给相关 `aap.llm.chat` / `aap.llm.chat_stream` 调用。仅传 payload 字符串、丢弃签名头或使用客户端自造身份头都不合规。匿名路由不传递访问者身份；若启用了 `passUser`，其中身份代表应用属主。LLM 网关始终按应用属主记账。
- **单线程请求**：在 Flask 请求处理期间成对读取两个头并显式传入 `identity`（如上例）；不要把读取身份的逻辑延迟到请求上下文之外。
- **后台线程 / 线程池**：若任务需要保留 `account` 路由访问者身份，在请求处理线程仍持有 Flask `request` 上下文时，先读取并校验两个头，形成 `(payload, sig)` 元组；把该元组作为任务参数传入每一层 worker，并在需要身份的 LLM 调用中显式传 `identity=identity`。后台线程不能依赖 Flask 的 `request` 上下文，也不能只传 payload。身份有效期为 10 分钟，不得写入数据库、持久队列、日志或作为长期任务凭据；身份过期且任务依赖该身份时，应要求用户重新发起。匿名 LLM 调用不需要访问者身份，费用仍归应用属主；如确需传身份，`passUser` 路由提供的是属主身份。
- **invoked 应用**：SDK 从平台注入的 `AAP_IDENTITY_PAYLOAD` 与 `AAP_IDENTITY_SIG` 环境变量获取当前路由身份（passUser 路由为属主，account 路由为实际访问者）；不得自行从浏览器读取或构造身份头。若应用把调用转交后台工作线程，在提交任务前从这两个环境变量捕获 `(payload, sig)` 并作为 `identity=` 显式传递；不要假定工作线程有 Flask 请求上下文。
- 走平台 LLM 网关（OpenAI 兼容）；应用调用的费用始终记入应用属主账号，克隆副本记入克隆属主账号。身份头用于传递经签名验证的运行身份，不改变费用归属。应用自建账号不自动成为平台计费身份；不要承诺应用访客可直接免费调用。
- 模型名以门户当前可用模型目录为准；写错或不可用会返回错误。根据任务类型向使用者推荐模型：简单短文本任务优先快且经济的模型，复杂推理/长文档选能力和上下文足够的模型，结构化输出任务选格式遵循稳定的模型；用代表性输入试用后再确定。
- 当前 SDK 的 `stream=True` 不代表上游模型的实时流式传输；不要依赖首 token 延迟或实时增量输出，需要实时流式时先确认平台 SDK 契约已更新。
- 不传 `max_tokens` 时的生成上限由平台设置 `LLM_SANDBOX_MAX_TOKENS` 统一治理（0 = 不限制）；显式指定可精确控制预检额度预估

后台任务示例（身份必须在请求线程中捕获，所有 LLM 调用都显式传入同一个短期元组）：

```python
import os
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, jsonify, request

app = Flask(__name__)
executor = ThreadPoolExecutor(max_workers=4)

def run_job(text, identity):
    return aap.llm.chat(
        messages=[{"role": "user", "content": text}],
        model=os.environ["MODEL"],
        identity=identity,
    )

@app.post("/jobs")
def create_job():
    payload = request.headers.get("X-AAP-Identity")
    signature = request.headers.get("X-AAP-Identity-Sig")
    if not payload or not signature:
        return jsonify({"error": "未收到完整的平台用户身份，请登录后重试"}), 401
    identity = (payload, signature)
    executor.submit(run_job, request.get_json()["text"], identity)
    return jsonify({"status": "queued"}), 202
```

不要把示例中的身份元组保存到任务表或长期队列；如任务可能排队超过身份有效期，应在有效期内执行模型调用或要求用户重新提交任务。禁止用捕获 `TypeError`、空身份或无归因策略作为自动回退。

### 3.1.1 `aap.llm` 媒体上传与异步 chat

图片/视频使用独立原始字节上传，随后以短期引用提交异步任务；不要把大文件 Base64 塞进普通 `aap.llm.chat`。单个图片最多 5 MiB，单个视频最多 50 MiB；每次 chat 的媒体合计最多 50 MiB、最多 20 个文件。支持 JPEG、PNG、WebP、GIF、MP4、WebM、MOV。上传引用绑定当前应用及平台用户，1 小时过期。

```python
import os
import time

media = aap.llm.upload_media("/tmp/receipt.jpg")
job = aap.llm.chat_async(
    messages=[{"role": "user", "content": "请识别图片中的内容"}],
    media=[media],
    model=os.environ["MODEL"],
    max_tokens=1200,
)

while True:
    job = aap.llm.get_chat_job(job["id"])
    if job["status"] in ("completed", "failed"):
        break
    time.sleep(1)

if job["status"] == "failed":
    raise RuntimeError(job["error"])
result = job["result"]
```

- `upload_media(file_path, content_type=None, progress=None, identity=None)` 通过 1 MiB 分块发送原始文件字节；上传回调参数是 `(已发送字节数, 文件总字节数)`，返回值含 `id`、`type`、`mimeType`、`size`、`uploadMs` 与 `expiresAt`。身份优先级沿用 `aap.llm.chat`；长期任务不得保存身份元组。
- `chat_async(messages, media, model=None, temperature=None, max_tokens=None, identity=None)` 返回 `id/status/stage`，平台把媒体引用附加到最后一条 user 消息；messages 应包含至少一条 user 消息。`get_chat_job(job_id, identity=None)` 返回任务状态，完成时含 OpenAI 兼容的 `result`，失败时含 `error`，并在 `timings` 提供 `uploadMs`、`queueMs`、`prepareMs`、`gatewayMs`、`totalMs` 与 `requestId`。
- 阶段包括 `queued`、`preparing`、`routing`、`preparing_media`、`upstream_processing`、`settling`、`completed`、`failed`。应用应轮询并向用户展示当前阶段；网络故障、模型路由不支持或上游失败均可能导致 `failed`。
- 有效身份签名 10 分钟过期。平台只在进程内排队身份，不会持久化；排队过久导致身份过期时，模型任务会失败，需由用户重新提交。仅为查询已提交任务，平台允许用原始签名身份在任务有效期内读取该任务状态/结果；该过期身份不能用于上传媒体、提交任务或新的 LLM 调用。任务状态与媒体引用最长保留 1 小时。
- 管理员须在模型路由中配置媒体格式：`image_url` 适用于图片；`video_url` 适用于图片和视频。`video_url` 是上游扩展格式，平台以 `data:video/...;base64,...` 发送，不属于所有 OpenAI-compatible 服务的通用约定；只有确认上游支持时才能启用。视频请求只选择 `video_url` 路由，不会降级为图片格式。
- 含图片或视频的异步 chat 默认最多等待上游 600 秒，可由管理员通过 `LLM_MEDIA_TIMEOUT_SECONDS` 调整。媒体计量以上游返回的 usage 为准；上游不返回 usage 时，平台估算会排除 Base64 媒体字节，不把文件大小误算成文本 token。

### 3.2 `aap.db` — 数据库（每包独立 SQLite，支持 SQL）

每个包拥有**独立的 SQLite 数据库**（自动创建、自动带包名命名空间，互不可见），在你的库内使用完整 SQL：

```python
# 建表与写入（首次会自动执行，重复执行请用 CREATE TABLE IF NOT EXISTS）
aap.db.execute("""
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_key TEXT NOT NULL,
        code TEXT NOT NULL,
        summary TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
""")
aap.db.execute(
    "INSERT INTO records (user_key, code, summary) VALUES (?, ?, ?)",
    ("u_1001", "600519", "……")
)

# 查询 → list[dict]
rows = aap.db.query(
    "SELECT code, summary FROM records WHERE user_key = ? ORDER BY id DESC LIMIT 10",
    ("u_1001",)
)
```

- **边界**：SQL 只作用于你包自己的库；平台业务表与其他包的数据**物理隔离、不可访问**，也没有跨库 join
- 参数一律用 `?` 占位符传入，不要拼接字符串（防注入是包作者自己的责任）
- 当前 SDK 未实现数据库容量/行数硬限额；应用须主动控制增长，避免在数据库中保存大文件。批量写入建议使用事务。
- 典型用法：**任务/结果表**（persistent 状态纪律，§二）、**按应用账号隔离的数据**（行键使用应用自己的账号键；只有 passUser 已启用并验签时才用平台身份键）

### 3.3 `aap.storage` — 文件存储（每包独立配额）

```python
aap.storage.put("uploads/abc.pdf", binary_bytes)
data = aap.storage.get("uploads/abc.pdf")            # → bytes
aap.storage.delete("uploads/abc.pdf")
files = aap.storage.list(prefix="uploads/")
```

- 每应用总配额默认 10 MiB；当前未实现单文件独立上限。适合小型应用文件、少量用户上传件和缓存；写入前检查剩余总配额并向用户明确提示容量不足。

### 3.4 出站 HTTP — 走代理，白名单放行

```python
resp = aap.http.fetch("https://api.example-data.com/v1/quote?code=600519")
# resp: {"status": 上游状态码, "body": 上游响应文本（≤500KB）}

# 需要鉴权的 API：headers 传自定义请求头（密钥从 os.environ 取，不要硬编码）
resp = aap.http.fetch(
    "https://api.example-data.com/v2/check",
    headers={"Key": os.environ["EXAMPLE_API_KEY"], "Accept": "application/json"},
)
```

- 仅支持 HTTP/HTTPS GET；不支持向上游提交请求体。域名必须列在 manifest `network`，平台逐跳重定向复核白名单和 DNS/IP。
- 默认拒绝 IP 字面量、localhost、私网/保留地址；管理员配置的内网 allowlist 可放行精确主机/CIDR，但链路本地地址仍拒绝。白名单只写主机名或受支持的通配域名，不写 scheme、端口、路径或 IP；manifest 当前没有条目数上限，仍应只列最小必要域名。
- 每次请求超时 15 秒、最多跟进 5 次重定向，返回文本最多 500,000 字符；`headers` 最多 16 项、名称最多 64 字符、值最多 4,096 字符。逐跳/代理托管头会被剥除。
- Python 网络守卫是纵深防御而非硬隔离；所有直接网络访问依然违反开发契约，出站只能用此接口。
- 无需自己处理 TLS/代理细节，fetch 直给结果（平台侧拒绝以异常抛出，上游错误码经 `resp["status"]` 判断）

### 3.5 `aap.log` — 日志（平台统一收口，v0.2 新增）

平台向 `mod.py` 注入配置好的日志处理器。用 `aap.log` 或 SDK 配置的 `aap` logger 输出的日志会收口进门户运行记录——本地调试、上传后试运行、线上调用，均可通过此通道观察。不要自建日志出口或将日志写到未授权位置；应用必须遵守平台网络与数据访问边界。

```python
aap.log.debug("解析输入: code=%s", code)         # 过程细节
aap.log.info("开始生成摘要 model=%s", model)     # 关键业务动作
aap.log.warning("上游返回空，使用降级文案")       # 可恢复异常
aap.log.error("生成失败: %s", err)               # 失败（同时按规范返回 {"error": ...}）
```

**级别语义**（平台按级别决定线上保留策略）：

| 级别 | 用途 | 线上保留 |
|---|---|---|
| `DEBUG` | 过程细节、中间值，帮助排查问题 | 否（仅本地调试/试运行保留） |
| `INFO` | 关键业务动作与结果（开始了什么、完成了什么、用了哪个模型） | 是 |
| `WARNING` | 可自动恢复的异常、降级、重试 | 是 |
| `ERROR` | 失败；必须配合返回 `{"error": "人类可读中文说明"}` | 是 |

**硬性要求**：
1. **禁止 `print()`**：stdout 是结构化出参通道（invoked 模式下协议载体），print 会污染协议、日志丢失。
2. **脱敏**：不打 API key/token/密码；用户敏感数据（手机号、邮箱、正文原文）打掩码（如 `u_100***`、`138****1234`）。
3. **限量**：单次运行日志有条数与字节上限（平台配置，超限截断并在运行记录里标记 truncated）；高频循环内不要逐条打 DEBUG，聚合成一条。
4. **日志不是返回值**：业务结果走 `return` / HTTP 响应；日志只做观测，别让用户"去日志里找结果"。

### 3.6 页面与浏览器会话纪律

用户应用使用独立 origin，不再运行在 opaque-origin iframe 中。HTML 静态应用和 persistent 页面都应按普通网站开发：

1. 可使用本应用 origin 的 `localStorage` / `sessionStorage` / host-only Cookie；需要跨请求共享或服务端访问的状态应写 `aap.db`/`aap.storage`。应用 Cookie 不要设置父域 `Domain`；服务端会话 Cookie 应设置 `Secure`、`HttpOnly`、合适的 `SameSite`，并保护状态变更请求免受 CSRF。
2. 这些浏览器存储属于应用自己的 origin，不会自动变成服务端身份；不得读写门户 DOM、门户存储或依赖门户登录 Cookie。平台会话 Cookie 不会转发给应用。
3. 不得把第三方 API 密钥、平台令牌放到 HTML/JavaScript 或浏览器存储；服务端配置走 `manifest.env`，并按密钥处理。
4. 应用页面不保证注入门户导航/悬浮条。需要返回入口时，提供指向用户已知应用门户地址的普通链接；不要假设门户 DOM 或 `postMessage` 桥存在。
5. 应用独立 origin 下可从根路径引用资源/API；相对 URL 也可用于子路径部署。若明确兼容旧 `/app/<id>/` 入口，再按 `X-Forwarded-Prefix` 适配。

---

## 四、mod.py 模板

### invoked 模板（数据处理 / LLM 工具）

```python
# manifest: type=python, runtime=invoked, capabilities=["llm"]
import os

def handle(input: dict, aap) -> dict:
    """
    input  = 用户表单提交的结构化数据（平台已按 manifest 校验）
    return = 渲染给用户的结构化结果
    """
    code = input["code"]                       # 表单字段名 = 你的入参名
    text = input.get("note", "")

    aap.log.info("收到摘要请求 code=%s", code)
    try:
        resp = aap.llm.chat(
            messages=[
                {"role": "system", "content": "你是财务摘要助手，输出 JSON"},
                {"role": "user", "content": f"股票 {code}，备注 {text}，生成三句话摘要"},
            ],
            model=os.environ["MODEL"],
            max_tokens=800,
        )
    except Exception as err:                   # noqa: BLE001 — 顶层兜底
        aap.log.error("LLM 调用失败: %s", err)
        return {"error": "摘要生成失败，请稍后重试"}

    aap.log.info("摘要完成 model=%s tokens=%s", resp.get("model"), resp.get("usage"))
    return {
        "summary": resp["content"],
        "model": resp["model"],
    }
```

用户侧表单字段由门户根据你在门户上配置的入参 Schema 生成（上传包后在管理后台/个人工具页可见），`input` 的键与之对应。

### persistent 模板（网页 / API 服务）

```python
# manifest: type=python, runtime=persistent, capabilities=["llm","storage"], route="writer"
import os
from flask import Flask, request, jsonify   # 平台预置常用 Web 框架，无需自带依赖

app = Flask(__name__)

@app.route("/")
def home():
    # 注意：相对路径；前缀由平台注入；右上角留白给门户统一按钮（见 §3.6）
    return '<h1>写作助手</h1><form action="./generate" method="post"><input name="topic"><button>生成</button></form>'

@app.route("/generate", methods=["POST"])
def generate():
    resp = aap.llm.chat(
        messages=[{"role": "user", "content": request.form["topic"]}],
        model=os.environ["MODEL"],
    )
    return jsonify({"text": resp["content"]})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8080)))
```

---

## 五、硬性约束与交付自检（违反 = 上传拒绝或运行报错；交付前逐条勾）

**manifest 与能力声明**

- [ ] manifest 各字段齐备；`capabilities` / `network` / `runtime` / `env` 与代码实际行为严格一致，按需最小声明；仅 `llm` 当前由服务端对未声明调用强制拒绝，`db`/`storage` 声明目前不构成逐项运行时闸
- [ ] 若这是既有应用的新更新包，已核对当前版本并递增 `manifest.version`（至少 PATCH）；交付说明标出旧版本 → 新版本，版本未知时先询问而非重置/猜测
- [ ] 外部配置项已声明 manifest `env`（§1.1）：必填/可选、secret、pattern 划分正确，代码经 `os.environ` 读取，未声明平台保留变量名
- [ ] 声明 `llm` 能力的包已声明必填 `env.MODEL`，代码显式将其传给 `aap.llm.chat`；不使用应用专属模型变量描述或硬编码模型
- [ ] 身份路由完整：匿名访问仍由应用级权限和 manifest 路由共同控制；`passUser` 注入属主身份，`account` 要求登录并注入实际访问者身份；后台任务捕获并逐层传递所需身份；所有 LLM 用量仍由应用属主承担
- [ ] 已按任务特征向使用者提供 `MODEL` 选择建议，并让使用者从门户当前模型目录试用配置；不假定或硬编码目录外模型
- [ ] 没有硬编码任何密钥/令牌；没有绕过平台向使用者索要密钥（前端输入框收 key = 设计错误）

**代码边界**

- [ ] Python 包单文件 `mod.py`（persistent 可带静态资源目录）；只用标准库 + 平台预置框架 + manifest `requirements` 声明的依赖（§1.2，上传时自动安装），无运行时自装
- [ ] 无自建网络出口（无 socket / os.system / 子进程）：出站只经 `aap.http.fetch`，域名全部在 manifest `network` 里，上游状态码 `resp["status"]` 逐分支处理
- [ ] invoked 出入参可 JSON 序列化（二进制存 storage 给链接）；长任务拆分或加进度说明（invoked 有超时）
- [ ] 错误路径友好：失败返回 `{"error": "人类可读的中文说明"}`

**运行时状态**

- [ ] invoked 无状态：跨请求状态一律落 `aap.db` / `aap.storage`
- [ ] persistent 状态纪律：任务/结果/草稿/每用户配置落 `aap.db`，不依赖进程内存（空闲回收约 5 分钟，§二）
- [ ] persistent：`PORT` 环境变量 + `127.0.0.1` 监听；以应用独立 origin 根路径工作（兼容路径模式才需 `X-Forwarded-Prefix`）
- [ ] 应用自己的登录态在应用 origin 内实现；仅在 passUser 明确启用时使用经过验签的平台身份，不将平台身份头当作外部用户登录机制
- [ ] 数据增长、HTTP 输入/输出、LLM token 与重试均有应用侧上限；不依赖平台未实现的 CPU/内存/数据库配额

**日志（§3.5）**

- [ ] 只用 `aap.log` / 标准 logging，没有 `print()`；级别语义正确、敏感信息脱敏、高频循环聚合不逐条 DEBUG；环境变量值不打进日志

**前端（HTML 工具与 persistent 页面通用，§3.6）**

- [ ] 浏览器会话仅使用应用 origin 的存储/Cookie；不读取门户数据，不在浏览器保存密钥
- [ ] 若应用有自己的账号体系，实现应用自己的登录、退出和安全会话；不要假设平台统一页面元素或 opaque-origin iframe
- [ ] 使用根路径或相对路径适配应用 origin；剪贴板等浏览器 API 做能力检测与合理降级

**交付**

- [ ] 已在本地 aap-dev 跑通（当前支持 invoked：`run` + mock LLM，见 §七；persistent 待 serve 上线，先以上传后试运行验证）

## 六、交付与上架流程

```
本地调试沙箱自测（§七 aap-dev：跑通 invoked、看详细日志）
   ↓  打包 ZIP（manifest.json + mod.py[/index.html]）
   ↓  上传门户 → 服务端校验 ZIP 结构与 manifest
   ↓  通过后立即安装为「私有」应用：上传者自己可见可用 ←— 先试运行并看运行记录
   ↓  用户可自行「发布为公开」（公开数量不受限制），无需管理员审核

```

给用户交付时：提供 ZIP 包 + 一段「如何自测」说明（本地 aap-dev 自测 → 上传 → 私有可见 → 试运行 → 自行决定是否公开）。平台不要求签名，也不维护发布者信任公钥列表；应用仍受包格式校验、沙箱与 manifest 能力边界约束。

用户上传应用数量受当前权益包限制，统计其已有的全部托管应用（私有与公开均计入）；更新已有应用不增加名额。公开发布不限制应用数量。

## 七、本地调试沙箱（aap-dev，v0.2 新增）

Python 代码需要调试。平台提供**本地调试沙箱**：它与线上运行共用 SDK/执行器核心；门户专属认证、资源调度及服务端强制能力闸不由本地工具完整模拟。调试模式下详细日志全开。**先在本地跑通，再上传。**

```bash
# 当前实装（invoked：本地执行一次 handle()）
aap-dev run mod.py --input input.json     # --input 缺省读 stdin；--llm 默认 mock（本地回声+夹具）
aap-dev run mod.py --reset                # 顺带清空本地 db/storage（.aap-dev/ 目录）

# 随平台 M4 完整版提供（当前未实装，勿依赖、勿写进交付说明）：
#   serve 子命令（persistent 本地起服务）、--llm real（经平台网关）、--submit（调试日志回传门户运行记录）
```

调试模式（`AAP_DEBUG=1`）下全量打印：

- 每次 `aap.*` 调用：接口名、入参（脱敏后）、出参摘要、耗时
- `aap.db`：实际执行的 SQL 与参数、影响行数
- `aap.storage`：每个文件操作与配额水位
- `aap.http.fetch`：URL、**白名单判定结果**、上游状态码、耗时
- `aap.llm.chat`：模型、token 用量、耗时（mock 模式标注 MOCK）
- 进程生命周期：启动、超时、退出码（invoked）

**与线上行为一致的边界**（刻意为之，别绕）：

- manifest `network` 白名单在本地照常强制执行——未声明的域名一样被拒
- 本地能力检查不应被视作生产服务端的安全边界；生产端当前只有 `llm` 能力有强制网关校验，开发仍须按 `capabilities` 最小声明
- invoked 的超时、JSON 校验、进程即毁语义完全相同

---

## 八、实战案例与坑清单

### 8.1 把现有 Web 项目重构为 .awpk 的方法论

移植/重构的实质是**逐项替换自建设施为平台能力**，业务逻辑保留：

| 自建设施 | 平台替代 |
|---|---|
| 用户/登录/OIDC/人机验证 | 平台可见性/登录门禁只决定能否进入应用；需要应用自有账号（含匿名访客、第三方用户）时，由应用自行实现注册、认证和会话，不能假设访客拥有平台账号 |
| LLM 接入（多上游/key/计费） | `aap.llm.chat` + passUser 归因（按浏览用户扣费，余额预检 402） |
| 密钥/配置保管 | manifest `env`（§1.1）+ 门户环境变量 |
| 中心数据库 | `aap.db`（按应用自有账号键隔离；仅启用并验签 passUser 时才按平台 `(kind, uid)` 归因） |
| 审计/运行记录 | 平台运行记录 + audit_logs（自动） |
| 出站 API 调用 | `aap.http.fetch` + manifest `network` 白名单 |

**案例 A · ip-analyzer**（Flask+AbuseIPDB → persistent 包，`examples/ip-analyzer/`）：
五个替换——requests→`aap.http.fetch`（鉴权头）、密钥 UI 收集→`env` 注入、socket 反查删除、
应用内跨请求任务状态落 `aap.db`；用户浏览器会话可以留在应用 origin 的 Cookie/storage。

**案例 B · llm-proofread**（React19+Express+tRPC+MySQL → 全新 persistent 包）：
自建用户系统、LLM 多上游接入、密钥保管、审计日志**整体删除**；包内只剩校对编排、
规则引擎、diff 呈现、每用户提示词/词库（aap.db）。完整设计见仓库内
`./llm-proofread-aap-design.md`（平台仓库参考，门户用户可忽略）。

### 8.2 坑清单（全部实测踩过；只列带独立诊断症状的条目，规则本体见 §二 / §3.x / §五）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| persistent 进程内存放任务/结果 | 空闲回收（默认约 5 分钟）后「任务不存在」 | 状态落 `aap.db`（§二 状态纪律） |
| `socket` / 直连网络 | 平台网络守卫报错，且违反规范 | `aap.http.fetch`（headers 带鉴权头，§3.4） |
| 忽略 `resp["status"]` | 上游 401/429 被当成功处理 | fetch 返回上游状态码，逐分支处理 |
| persistent Cookie 设置父域 `Domain` | 代理移除 `Domain` 以隔离平台与应用 Cookie | 使用应用自己的 host-only Cookie；旧路径兼容入口不要作为会话部署方式 |
| `print()` 调试 | invoked 下污染 JSON 出参协议；日志丢失 | `logging`（"aap.*" logger）/ `aap.log`（§3.5） |

---

*本规范由 ai-app-panel 维护；接口面（§三）变更必须升版本并同步 `app-develop-internal.skill.md` 的平台实现约定。*
