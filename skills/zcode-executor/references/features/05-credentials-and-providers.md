# 05 · 凭据与 provider 选路

## 凭据解密（credentials.json）

`~/.zcode/v2/credentials.json` **绝对只读**（静态红线：全仓禁止写/删 `~/.zcode/v2`）。解密算法与 ZCode 源码逐行等价：AES-256-GCM。

**两种格式**：

- `enc:v1:<iv>.<tag>.<密文>`（三段 base64url）：密钥 `sha256(ZCODE_CREDENTIAL_SECRET 或 fallback(platform:homedir:username))`；App 3.18 起候选表第一把是凭据旁的 `credential-secret` 文件（legacySecret）或 env 原样（未 trim 也能解）。
- `enc:v2:<源>:<密钥指纹>:<iv>.<tag>.<密文>`：源为 `os`（钥匙串 32 字节随机数，指纹匹配）或 `env`（`sha256(managed secret)`）；指纹对不上 = 存储不可用，**不换源**（照 App 口径）。
- `credential-source` 钉源文件：内容为 `os\n` 才算钉到 os；钉了别的值整份按不可用处理。
- 其它 `enc:<未知版本>` 前缀**不当明文放行**，直接报「格式不认得」（v0.6.2 前误放的根因）。

**红线**：密钥文件（`ZCODE_CREDENTIAL_SECRET_FILE`）不查权限位（照 App）；临时 provider 文件必须 `mkdtemp` + `0600` + `finally` 保证删除；JWT/key 只进内存。

## provider 选路（pickProvider，D6 优先级）

```
preferredProvider（显式指定，必须命中）
> account:*-individual-coding-plan（账号型个人版——key 最稳、按量风险小）
> account:*-team-coding-plan
> id 以 -coding-plan 结尾
> id 以 -start-plan 结尾
> 其它（同级取 registry 靠前）
```

3.12 起 provider 表不由客户端推：app-server 启动时从两个环境变量指的文件读——内置（`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，缺失直接拒启动）+ 个人（`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，executor 自己写、用完即删）。

## Gotchas

1. **报错先看 `error.data.details`**——`-32601`（方法删了）/`-32602`（参数形状不对）等真错误码在 details，顶层 message 只是套话。3.12 删掉的东西：`workspace/updateProviderRegistry`、`create` 的 `runtimeModel` 字段（改用 `model` + 顶层 `thoughtLevel`）。
2. **api-key 型 provider 不会要运行时头**：`interaction/requestProviderRuntimeHeaders` 只在特定场景发（start plan JWT）。模型请求直接用个人文件里的 key。
3. **凭据探针是零 token 的**：`control-executor doctor` 含凭据键可读性检查（只报成功/失败+长度，永不打印明文）。
4. **`ZCODE_DATA_BASE_DIR` 决定凭据根**：测试用夹具目录 + 固定测试密钥，全程不读真实 `~/.zcode`。
