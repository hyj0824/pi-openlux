/**
 * OpenLux 中转站自动模型发现
 *
 * 做两件事：
 * 1. 启动时 / 打开 `/model` 时拉取 https://api.openlux.ai/api/pricing，
 *    把中转站「对话 + 支持工具」的模型自动补进 openlux 的模型列表。
 * 2. `~/.pi/agent/models.json` 里手工维护的模型仍然优先（同 id 不覆盖），
 *    所以那份文件继续当作手工调参表用。
 *
 * 元数据来源：
 * - 价格/能力/端点类型  → 中转站定价接口（实时）
 * - 上下文/最大输出/思考 → pi 自带模型目录里同 id 的条目（`pi update --models` 更新）
 * - 两者都没有时按模型家族给保守默认值
 *
 * 新增模型立刻可用；想手工调某个模型，把它从 models.json 里加进
 * `providers.openlux.models` 即可（扩展发现同 id 时以手工条目为准）。
 *
 * 优先级：`~/.pi/agent/models.json` 手工条目 > 包内 `defaults/models.json` > 自动发现。
 * 所以新设备上只要装包 + 配好 key，不写 models.json 也能直接用。
 */

import { readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PROVIDER_ID = "openlux";
const PRICING_URL = "https://api.openlux.ai/api/pricing";
const OPENAI_BASE = "https://api.openlux.ai/v1";
const ANTHROPIC_BASE = "https://api.openlux.ai";
const GEMINI_BASE = "https://api.openlux.ai/v1beta";

/** 中转站的 model_ratio 1 = 每百万 token 2 美元 */
const USD_PER_RATIO = 2;
/** 只收录带「工具」标签的对话模型（pi 是 agent，需要 tool calling） */
const REQUIRE_TOOL_TAG = true;
/** 设为 1 时即使 pi 处于「离线启动阶段」也拉取目录，便于 `OPENLUX_FORCE_REFRESH=1 pi --list-models` */
const FORCE_REFRESH = process.env.OPENLUX_FORCE_REFRESH === "1";

const GENERIC_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
} as const;

const DEEPSEEK_COMPAT = {
  ...GENERIC_COMPAT,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
  supportsMidConvoSystemMessages: true,
} as const;

type ModelConfig = Record<string, unknown> & { id: string };
type BuiltinModel = Record<string, any>;

// ---------------------------------------------------------------- 工具函数

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function debug(message: string): void {
  if (process.env.OPENLUX_DEBUG !== "1") return;
  void appendFile("/tmp/openlux-debug.log", `${new Date().toISOString()} [${process.pid}] ${message}\n`).catch(() => {});
}

/** 扩展自己的发现缓存（不复用 pi 的 models-store，避免和 publish 队列竞争） */
function cachePath(): string {
  return join(agentDir(), PROVIDER_ID + "-models.json");
}

async function readCache(): Promise<ModelConfig[]> {
  try {
    const parsed = parseJsonLoose(await readFile(cachePath(), "utf8"));
    const models = Array.isArray(parsed) ? parsed : parsed?.models;
    return Array.isArray(models) ? models.filter((m: any) => m && typeof m.id === "string") : [];
  } catch {
    return [];
  }
}

async function writeCache(models: ModelConfig[]): Promise<void> {
  try {
    await writeFile(cachePath(), JSON.stringify({ checkedAt: Date.now(), models }, null, 2) + "\n");
  } catch {
    // 缓存写不了不影响本次使用
  }
}

/** pi 允许 models.json 带注释，这里做一次字符串感知的注释剥离，避免直接 JSON.parse 失败。 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonLoose(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(stripJsonComments(raw));
    } catch {
      return undefined;
    }
  }
}

function readJsonSync(path: string): any {
  try {
    return parseJsonLoose(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** 注册瞬间就要有模型：同步读 models.json 的 provider 块 + 上次的发现缓存。 */
function readProviderBlockSync(): Record<string, any> | undefined {
  return readJsonSync(join(agentDir(), "models.json"))?.providers?.[PROVIDER_ID];
}

/** 包内自带的兜底清单：设备上没有 models.json 时用它打底 */
function readPackageDefaultsSync(): ModelConfig[] {
  try {
    const parsed = parseJsonLoose(readFileSync(new URL("../defaults/models.json", import.meta.url), "utf8"));
    const models = Array.isArray(parsed) ? parsed : parsed?.models;
    return Array.isArray(models) ? models.filter((m: any) => m && typeof m.id === "string") : [];
  } catch {
    return [];
  }
}

function modelsOf(provider: Record<string, any> | undefined): ModelConfig[] {
  const models = Array.isArray(provider?.models) ? provider.models : [];
  return models.filter((m: any) => m && typeof m.id === "string");
}

function readCacheSync(): ModelConfig[] {
  const parsed = readJsonSync(cachePath());
  const models = Array.isArray(parsed) ? parsed : parsed?.models;
  return Array.isArray(models) ? models.filter((m: any) => m && typeof m.id === "string") : [];
}

async function readModelsJson(): Promise<Record<string, any> | undefined> {
  try {
    return parseJsonLoose(await readFile(join(agentDir(), "models.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** 手工维护的 openlux 条目（models.json）。扩展发现同 id 时以它们为准。 */
async function readCurated(): Promise<{ models: ModelConfig[]; baseUrl?: string; apiKey?: string }> {
  const config = await readModelsJson();
  const provider = config?.providers?.[PROVIDER_ID];
  const models = Array.isArray(provider?.models)
    ? provider.models.filter((m: any) => m && typeof m.id === "string")
    : [];
  return { models, baseUrl: provider?.baseUrl, apiKey: provider?.apiKey };
}

function mergeById(base: ModelConfig[], extra: ModelConfig[]): ModelConfig[] {
  const seen = new Set(base.map((m) => m.id));
  const merged = [...base];
  for (const model of extra) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

// -------------------------------------------------- pi 自带模型目录（元数据）

let builtinIndex: Map<string, BuiltinModel[]> | undefined;

function familyApi(id: string): string {
  if (/^claude-/i.test(id)) return "anthropic-messages";
  if (/^gpt-|^o\d/i.test(id)) return "openai-responses";
  if (/^gemini-/i.test(id)) return "google-generative-ai";
  return "openai-completions";
}

function getBuiltinIndex(): Map<string, BuiltinModel[]> {
  if (builtinIndex) return builtinIndex;
  const index = new Map<string, BuiltinModel[]>();
  try {
    for (const provider of builtinProviders()) {
      const all = (provider as any).getAllModels?.() ?? provider.getModels();
      for (const model of all) {
        if ((model as any).type && (model as any).type !== "chat") continue;
        const list = index.get(model.id) ?? [];
        list.push(model as BuiltinModel);
        index.set(model.id, list);
      }
    }
  } catch {
    // 拿不到目录就退回启发式默认值
  }
  builtinIndex = index;
  return index;
}

/** 同 id 的目录条目里挑一条最贴近该家族常用 API 的（有输出上限的优先）。 */
function lookupBuiltin(id: string): BuiltinModel | undefined {
  const candidates = getBuiltinIndex().get(id);
  if (!candidates?.length) return undefined;
  const preferred = familyApi(id);
  const score = (m: BuiltinModel) =>
    (m.api === preferred ? 100 : 0) + (m.provider === "openai" || m.provider === "anthropic" || m.provider === "google" ? 10 : 0) + (m.maxTokens ? 1 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------ 启发式默认值

const CONTEXT_HINTS: Array<[RegExp, number]> = [
  [/^claude-haiku-4-5/i, 200000],
  [/^claude-/i, 1000000],
  [/^gemini-/i, 1048576],
  [/^gpt-/i, 400000],
  [/^grok-/i, 500000],
  [/^kimi-/i, 262144],
  [/^qwen/i, 262144],
  [/^glm-/i, 1000000],
  [/^deepseek-/i, 1000000],
  [/^MiniMax-/i, 204800],
];

/** 从描述里读「1M / 105 万 / 200K 上下文」，读不到再按家族给默认值。 */
function guessContextWindow(id: string, description: string): number {
  const text = String(description ?? "");
  const match =
    text.match(/(\d+(?:\.\d+)?)\s*(万|亿|k|K|M|m)\s*(?:token|tokens|令牌|上下文)/i) ??
    text.match(/(?:上下文|context(?:\s*window)?)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(万|亿|k|K|M)/i);
  if (match) {
    const value = Number.parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "万") return Math.round(value * 1e4);
    if (unit === "亿") return Math.round(value * 1e8);
    if (unit === "k") return Math.round(value * 1e3);
    if (unit === "m") return Math.round(value * 1e6);
  }
  for (const [pattern, value] of CONTEXT_HINTS) {
    if (pattern.test(id)) return value;
  }
  return 200000;
}

function guessMaxTokens(id: string): number {
  if (/^gemini-/i.test(id)) return 65536;
  if (/^claude-|^gpt-|^grok-/i.test(id)) return 64000;
  return 32768;
}

// ------------------------------------------------------------ 中转站定价接口

function buildCost(entry: Record<string, any>): Record<string, unknown> {
  const base = Number(entry.model_ratio ?? 0) * USD_PER_RATIO;
  const input = round6(base);
  const output = round6(base * Number(entry.completion_ratio ?? 0));
  const cacheRead = round6(base * Number(entry.cache_ratio ?? 0));
  const cacheWrite = round6(
    base * Number(entry.cache_creation_ratio ?? entry.cache_creation_5m_ratio ?? 0),
  );

  const cost: Record<string, unknown> = { input, output, cacheRead, cacheWrite };

  const tiers = (Array.isArray(entry.step_ratios) ? entry.step_ratios : [])
    .map((step: Record<string, any>) => {
      const promptRatio = Number(step.prompt_step_ratio ?? 1);
      const completionRatio = Number(step.completion_step_ratio ?? 1);
      const cacheRatio = Number(step.cache_step_ratio ?? 1);
      if (promptRatio === 1 && completionRatio === 1 && cacheRatio === 1) return undefined;
      return {
        inputTokensAbove: Math.trunc(Number(step.step_size ?? 0)),
        input: round6(input * promptRatio),
        output: round6(output * completionRatio),
        cacheRead: round6(cacheRead * cacheRatio),
        cacheWrite: round6(cacheWrite * cacheRatio),
      };
    })
    .filter(Boolean);

  if (tiers.length > 0) cost.tiers = tiers;
  return cost;
}

/** 端点类型 → pi 的 api + baseUrl。政策与手工配置保持一致。 */
function pickTransport(id: string, endpoints: string[]): { api: string; baseUrl: string } | undefined {
  const has = (name: string) => endpoints.includes(name);

  // Claude 走原生 Anthropic 端点，才能吃到 prompt caching 与原生 thinking
  if (/^claude-/i.test(id) && has("anthropic")) return { api: "anthropic-messages", baseUrl: ANTHROPIC_BASE };
  // OpenAI GPT 系必须 Responses：chat/completions 下 tools + reasoning_effort 会被上游拒绝
  if (/^gpt-/i.test(id) && has("openai-response")) return { api: "openai-responses", baseUrl: OPENAI_BASE };
  if (has("openai")) return { api: "openai-completions", baseUrl: OPENAI_BASE };
  if (has("openai-response")) return { api: "openai-responses", baseUrl: OPENAI_BASE };
  if (has("anthropic")) return { api: "anthropic-messages", baseUrl: ANTHROPIC_BASE };
  if (has("gemini")) return { api: "google-generative-ai", baseUrl: GEMINI_BASE };
  return undefined;
}

function buildCompat(id: string, api: string, builtin?: BuiltinModel): Record<string, unknown> | undefined {
  if (api === "openai-completions") {
    return /^deepseek-/i.test(id) ? { ...DEEPSEEK_COMPAT } : { ...GENERIC_COMPAT };
  }
  if (api === "anthropic-messages") {
    const compat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(builtin?.compat ?? {})) {
      if (key === "allowedFallbackModels") continue; // 指向官方 provider，经中转站不可用
      compat[key] = value;
    }
    // 该站部分 Claude 上游是 AWS Bedrock，会拒绝这个实验字段
    compat.supportsEagerToolInputStreaming = false;
    return compat;
  }
  return undefined;
}

function deriveModel(entry: Record<string, any>): ModelConfig | undefined {
  const id = String(entry.model_name ?? "").trim();
  if (!id) return undefined;

  const tags = String(entry.tags ?? "");
  const endpoints = Array.isArray(entry.supported_endpoint_types) ? entry.supported_endpoint_types : [];
  const transport = pickTransport(id, endpoints);
  if (!transport) return undefined;

  const builtin = lookupBuiltin(id);
  const reasoning =
    typeof builtin?.reasoning === "boolean" ? builtin.reasoning : tags.includes("思考") || /^claude-|^gpt-/i.test(id);
  const input = builtin?.input ?? (Number(entry.show_image_upload) === 1 || tags.includes("识图") ? ["text", "image"] : ["text"]);

  const model: ModelConfig = {
    id,
    name: builtin?.name ?? id,
    api: transport.api,
    baseUrl: transport.baseUrl,
    reasoning,
    input,
    cost: buildCost(entry),
    contextWindow: builtin?.contextWindow ?? guessContextWindow(id, String(entry.description ?? "")),
    maxTokens: builtin?.maxTokens ?? guessMaxTokens(id),
  };

  if (builtin?.thinkingLevelMap) model.thinkingLevelMap = builtin.thinkingLevelMap;
  if (builtin?.inputLimits) model.inputLimits = builtin.inputLimits;

  const compat = buildCompat(id, transport.api, builtin);
  if (compat && Object.keys(compat).length > 0) model.compat = compat;

  return model;
}

async function fetchDiscovered(signal: AbortSignal): Promise<ModelConfig[]> {
  const response = await fetch(PRICING_URL, {
    signal,
    headers: { Accept: "application/json", "User-Agent": "pi-openlux-extension" },
  });
  if (!response.ok) throw new Error(`pricing endpoint returned ${response.status}`);

  const payload = (await response.json()) as { data?: Record<string, any>[]; success?: boolean };
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  const discovered: ModelConfig[] = [];
  for (const row of rows) {
    if (row?.available === false) continue;
    if (String(row?.model_type ?? "") !== "对话") continue;
    if (REQUIRE_TOOL_TAG && !String(row?.tags ?? "").includes("工具")) continue;
    const model = deriveModel(row);
    if (model) discovered.push(model);
  }
  return discovered;
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

// ------------------------------------------------------------------- 扩展

/**
 * 同步工厂：注册必须发生在同步加载阶段，异步工厂会让 provider 在
 * `pi --print --model ...` 这类早期模型解析里偶尔「不存在」。
 * provider 级 baseUrl / apiKey 与 models.json 保持一致，随时可用。
 */
export default function (pi: ExtensionAPI) {
  debug("factory start");
  // models.json 是唯一的手工配置入口：provider 级 baseUrl / apiKey 也从那里取。
  // 注意扩展注册的 apiKey 会覆盖 models.json，所以必须显式透传。
  const block = readProviderBlockSync();
  let curated: ModelConfig[] = modelsOf(block);
  const defaults = readPackageDefaultsSync();
  const seed = mergeById(curated, defaults);
  const initial = mergeById(seed, readCacheSync());
  debug(`registered with ${initial.length} models (curated=${curated.length} defaults=${defaults.length})`);

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenLux 中转站",
    baseUrl: block?.baseUrl ?? OPENAI_BASE,
    apiKey: block?.apiKey ?? "$OPENLUX_API_KEY",
    api: "openai-completions",
    models: initial,
    async refreshModels(context: any) {
      // 先读手工清单：它在任何情况下都要出现，也是发现项的兜底
      const config = await readCurated();
      curated = config.models;

      const cached = await readCache();
      const base = mergeById(curated, defaults);
      debug(`refresh allowNetwork=${context?.allowNetwork} curated=${curated.length} base=${base.length} cached=${cached.length}`);

      if ((!context?.allowNetwork && !FORCE_REFRESH) || context?.signal?.aborted) {
        return mergeById(base, cached);
      }

      try {
        const discovered = await fetchDiscovered(withTimeout(context.signal, 15000));
        if (context.signal?.aborted) return mergeById(base, cached);

        const merged = mergeById(base, discovered);
        // 存一份，离线启动时也能看到上次发现的模型
        await writeCache(merged);
        debug(`refresh network done: discovered=${discovered.length} merged=${merged.length}`);
        return merged;
      } catch (error) {
        debug(`refresh network failed: ${error instanceof Error ? error.message : String(error)}`);
        return mergeById(base, cached);
      }
    },
  });

  debug("factory done / provider registered");

  pi.registerCommand("openlux", {
    description: "刷新 OpenLux 模型目录并列出新发现的模型",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus?.("openlux", "刷新 OpenLux 目录…");
      try {
        const discovered = await fetchDiscovered(withTimeout(new AbortController().signal, 15000));
        const config = await readCurated();
        const known = new Set(config.models.map((m) => m.id));
        const fresh = discovered.filter((m) => !known.has(m.id)).map((m) => m.id);
        ctx.ui.setStatus?.("openlux", undefined);
        if (fresh.length === 0) {
          ctx.ui.notify(`OpenLux：${discovered.length} 个可用模型，没有新模型`, "info");
          return;
        }
        ctx.ui.notify(
          `OpenLux：发现 ${fresh.length} 个新模型（共 ${discovered.length} 个）。打开 /model 刷新列表：\n${fresh
            .slice(0, 30)
            .join(", ")}${fresh.length > 30 ? " …" : ""}`,
          "info",
        );
      } catch (error) {
        ctx.ui.setStatus?.("openlux", undefined);
        ctx.ui.notify(`OpenLux：拉取目录失败（${error instanceof Error ? error.message : String(error)}）`, "warning");
      }
    },
  });
}
