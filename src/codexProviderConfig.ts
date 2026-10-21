import * as TOML from "@iarna/toml";

export type CodexConfig = Record<string, unknown>;
export interface NewApiProvider { baseUrl: string; apiKey: string }

export function parseCodexConfig(text: string): CodexConfig {
  try { return TOML.parse(text) as CodexConfig; }
  catch { throw new Error("无法解析 Codex config.toml，请先修复 TOML 格式后重试。"); }
}

export function validateProviderId(id: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) {
    return "请输入服务商 ID（字母、数字、下划线、点或短横线），例如 beeapi。";
  }
  if (["openai", "ollama", "lmstudio", "amazon-bedrock"].includes(id.toLowerCase())) {
    return "这是内置服务商 ID；官方登录请选择 OpenAI 官方，自定义 API 请使用其他 ID。";
  }
  return undefined;
}

export function getApiProvider(config: CodexConfig, id: string): CodexConfig | undefined {
  const providers = config.model_providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  const provider = Object.prototype.hasOwnProperty.call(providers, id)
    ? (providers as CodexConfig)[id] : undefined;
  return provider && typeof provider === "object" && !Array.isArray(provider) ? provider as CodexConfig : undefined;
}

// Find complete root statements without mistaking strings, arrays or comments
// for table headers. Only selected root keys are changed; provider secrets,
// comments, project settings and multiline strings stay byte-for-byte intact.
function rootStatements(text: string): Array<{ start: number; end: number; key: string }> {
  const statements: Array<{ start: number; end: number; key: string }> = [];
  let start = -1, depth = 0, quote = "", multiline = false, comment = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i] ?? "\n";
    if (comment) { if (ch !== "\n") continue; comment = false; }
    if (quote) {
      if (quote === '"' && ch === "\\") { i++; continue; }
      if (multiline && text.slice(i, i + 3) === quote.repeat(3)) {
        // TOML allows up to two literal quotes before a closing triple quote.
        let length = 3;
        while (text[i + length] === quote && length < 5) length++;
        i += length - 1; quote = ""; multiline = false;
      } else if (!multiline && ch === quote) quote = "";
      continue;
    }
    if (start < 0) {
      if (/\s/.test(ch)) continue;
      if (ch === "#") { comment = true; continue; }
      if (ch === "[") break;
      start = i;
    }
    if (ch === "#") comment = true;
    else if (ch === '"' || ch === "'") {
      quote = ch; multiline = text.slice(i, i + 3) === ch.repeat(3);
      if (multiline) i += 2;
    } else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "\n" && depth === 0) {
      const statement = text.slice(start, i);
      const match = /^(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')\s*=/.exec(statement);
      if (match) statements.push({ start, end: Math.min(i + 1, text.length), key: match[1] ?? match[2] ?? match[3] });
      start = -1;
    }
  }
  return statements;
}

export function buildProviderConfig(
  text: string,
  id: string,
  newProvider?: NewApiProvider,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const config = parseCodexConfig(text);
  if (config.profile) {
    throw new Error("当前 Codex 配置启用了 profile。请先取消 profile 或将服务商配置移到用户级 config.toml，再切换。");
  }
  if (id !== "openai") {
    const error = validateProviderId(id);
    if (error) throw new Error(error);
    const provider = getApiProvider(config, id);
    if (!provider && !newProvider) throw new Error("未找到对应的 API 配置，请先填写接口地址和 API Key。");
    if (provider?.requires_openai_auth === true) {
      throw new Error("该自定义服务商要求 OpenAI 登录。请先将对应配置的 requires_openai_auth 改为 false，再作为 API 服务商切换。");
    }
    if (provider && (typeof provider.base_url !== "string" || !isApiUrl(provider.base_url))) {
      throw new Error("该服务商缺少有效的 base_url，请先在 Codex config.toml 中补全。");
    }
    if (provider && !provider.env_key && !provider.experimental_bearer_token && !provider.auth && !provider.http_headers && !provider.env_http_headers) {
      throw new Error("该服务商缺少 API 凭据配置，请先配置 env_key、experimental_bearer_token 或认证请求头。");
    }
  } else if (environment.OPENAI_BASE_URL && !isOfficialApiUrl(environment.OPENAI_BASE_URL)) {
    throw new Error("当前扩展宿主设置了自定义 OPENAI_BASE_URL。请先清除该环境变量并重新加载窗口，再切换官方登录。");
  }
  if (newProvider && (!isApiUrl(newProvider.baseUrl) || !newProvider.apiKey.trim())) {
    throw new Error("请输入有效的 HTTP/HTTPS 接口地址和非空 API Key。");
  }
  const remove = new Set(["model_provider", "forced_login_method"]);
  if (id === "openai") { remove.add("openai_base_url"); remove.add("chatgpt_base_url"); }
  let rest = text;
  for (const span of rootStatements(text).reverse()) {
    if (remove.has(span.key)) rest = rest.slice(0, span.start) + rest.slice(span.end);
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // Custom providers use their own configured credentials. Do not force API
  // login: Codex could otherwise discard an existing ChatGPT login on reload.
  const header = `model_provider = ${JSON.stringify(id)}${newline}` +
    (id === "openai" ? `forced_login_method = "chatgpt"${newline}` : "");
  let result = header + rest;
  if (newProvider && !getApiProvider(config, id)) {
    result += `${newline}[model_providers.${JSON.stringify(id)}]${newline}` +
      `name = ${JSON.stringify(id)}${newline}base_url = ${JSON.stringify(newProvider.baseUrl.trim())}${newline}` +
      `wire_api = "responses"${newline}requires_openai_auth = false${newline}` +
      `experimental_bearer_token = ${JSON.stringify(newProvider.apiKey.trim())}${newline}`;
  }
  const parsed = parseCodexConfig(result);
  if (parsed.model_provider !== id) throw new Error("服务商配置校验失败，未写入文件。");
  return result;
}

export function isApiUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && Boolean(url.hostname); }
  catch { return false; }
}

function isOfficialApiUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "api.openai.com" && !url.username && !url.password; }
  catch { return false; }
}
