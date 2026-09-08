// 本文件负责：文本与结构里的密钥脱敏（redactSecrets 的键名替换、scrubValues 的按值替换）。
// 不负责：provider 表构造与配置读取（那是 lib/providers.mjs 的事）；两者分开是因为协议层
// 的 stderr 转发也要用 scrubValues，协议层不该依赖配置层（RULES §1，T0.3b 复核 B）。
// 被依赖方：lib/appserver.mjs（stderr/非 JSON 行转发）、lib/providers.mjs（探针输出）、外壳层。
// 安全边界（RULES §6、§8）：凡是要打印、落盘、进日志的数据，先过这里，密钥只换不漏。

// 键名命中即脱敏（不分大小写）。只按名字精确匹配，不做子串匹配。
const SECRET_KEY_NAMES = new Set(['apikey', 'token', 'secret']);

// 按值替换的最短长度。极短字符串（'x'、'abc'）会把正常输出打烂，不当密钥处理（T0.3b 复核 C）。
const MIN_SECRET_LENGTH = 8;

/**
 * 纯函数：深拷贝并把键名为 apiKey / token / secret（不分大小写）的值替换成
 * '<redacted>'。凡是往 stdout、日志、落盘 JSON 里放的数据都先过这里。
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_NAMES.has(k.toLowerCase()) ? '<redacted>' : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/**
 * 纯函数：按值替换——把 text 里出现的每个 secret 字符串换成 '<redacted>'
 * （T0.2c 评审第 5 条：redactSecrets 只认键名，拦不住错误消息正文、stderr 行里的密钥值）。
 * 长度不足 MIN_SECRET_LENGTH 的 secret 忽略；用 split/join 而不是正则，密钥里的
 * 正则元字符不用转义。
 */
export function scrubValues(text, secrets) {
  let out = text;
  for (const secret of secrets ?? []) {
    if (secret && secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join('<redacted>');
  }
  return out;
}
