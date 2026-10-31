# .asp-app 包签名机制（Ed25519 信任链）

> 设计参照 fnos-dashboard 的 ndash 签名方案；算法 Ed25519（RFC 8032），
> 服务端验证用 Node 内置 crypto（`apps/server/src/lib/signing.ts`），
> 签名/验签工具为 `packages/aap-sdk/sign-aap.mjs`（Node ≥ 22，无第三方依赖）。

## 一、解决什么问题

签名只防两件事：**篡改**（包内容与签名不符）与**冒名**（伪造官方发布者）。
它证明「包出自该私钥持有者」，不背书包的行为安全——第三方包的行为风险
仍由平台沙箱边界（G2）兜底。

## 二、包结构

```
pkg.asp-app（ZIP）
├── manifest.json      必需
├── index.html / mod.py …
└── signature.json     平台接收必需（sign 子命令生成/覆盖）
```

`signature.json`：

```json
{
  "alg": "ed25519",
  "payload_sha256": "<规范化摘要 hex>",
  "signature": "<base64 的 64 字节签名>",
  "signer": {
    "id": "署名",
    "key_id": "SHA256:<sha256(public_key) 前 8 字节 hex>",
    "public_key": "<base64 的 32 字节 Ed25519 公钥>"
  }
}
```

**规范化摘要**：对包内除 `signature.json` 外的全部条目，按「条目文件名
UTF-8 字节序」排序，逐项计算 `name_utf8 + 0x00 + sha256(content)` 并拼接，
最终 `sha256` 取 hex。与 zip 时间戳、压缩参数、条目物理顺序无关——内容
一致则摘要一致。

## 三、操作

```bash
# 生成密钥对（仅需一次；私钥 0600，妥善保管，勿提交仓库）
node packages/aap-sdk/sign-aap.mjs keygen -o mykey.secret

# 打包后签名（会覆盖包内 signature.json）
node packages/aap-sdk/sign-aap.mjs sign dist/demo.asp-app --key mykey.secret --signer your-name

# 发行前自检（只验完整性；「可信」由平台信任列表判定）
node packages/aap-sdk/sign-aap.mjs verify dist/demo.asp-app
```

⚠️ 修改包内容后必须**重新签名**，否则平台判定 `invalid` 拒绝上传。

## 四、平台侧验证（四态）

| 状态 | 含义 | 平台行为 |
|---|---|---|
| `verified` | 签名有效 + key_id 命中信任列表且公钥完全匹配 | **接受并立即安装为私有应用**；用户可自行发布为公开 |
| `untrusted` | 签名有效，但签名者不在信任列表 | 拒绝接收（`PACKAGE_SIGNER_UNTRUSTED`） |
| `unsigned` | 包内无 signature.json | 拒绝接收（`PACKAGE_SIGNATURE_REQUIRED`） |
| `invalid` | 签名/摘要不符（篡改、字段损坏） | **硬拒上传**（`PACKAGE_TAMPERED`） |

状态落 `apps.signature_status`。管理员上传接口采用相同接收策略。上传不进入管理员审核流程；公开发布仍受上传者订阅额度限制。

## 五、信任列表管理

- 表 `trusted_signing_keys`（key_id 唯一；`builtin` 标记内置不可删）
- 管理 API（管理员）：
  - `GET /api/admin/signing-keys`
  - `POST /api/admin/signing-keys` `{ name, publicKey }`（base64 32 字节）
  - `DELETE /api/admin/signing-keys/:id`（builtin 拒绝）
- 发布者将 `keygen` 输出的 `.pub` 公钥交给管理员加入信任列表；之后使用对应私钥签包。私钥不得提交仓库或放入包内。
- **内置官方公钥**：部署时设环境变量
  `AAP_OFFICIAL_SIGN_PUBKEY=<base64 公钥>`（可选 `AAP_OFFICIAL_SIGNER_NAME`），
  启动时自动种入并标记 builtin——对应签名包可直接接收
- 验证边界：签名验证在服务端上传时进行；沙箱运行时不需要也不读取签名。
