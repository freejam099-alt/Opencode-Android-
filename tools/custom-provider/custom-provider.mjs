#!/usr/bin/env node
// tools/custom-provider/custom-provider.mjs
//
// Manage custom OpenAI-compatible providers for OpenCode on Termux/Android.
// Zero dependencies; runs on bun or node >= 18.
//
// Design rules (see docs/custom-provider.md):
//  * Only touches `provider.<id>` entries that this tool created. Everything
//    else in opencode.json(c) -- including the built-in OpenCode Zen provider
//    ("opencode") -- is preserved byte-for-byte in meaning, and verified by an
//    invariant check before every write.
//  * API keys never go into opencode.json. They live in a 0600 file and the
//    config references it through the documented `{file:...}` substitution.
//  * No network access at OpenCode startup: models are fetched on demand and
//    written as a static `models` map (capped, to keep config parsing fast).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import http from "node:http"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const NPM_PKG = "@ai-sdk/openai-compatible"
export const RESERVED_IDS = new Set([
  "opencode", // OpenCode Zen -- must never be touched
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "github-copilot",
  "azure",
  "amazon-bedrock",
  "xai",
  "groq",
  "deepseek",
  "mistral",
])
const DEFAULT_RELAY_PORT = 18791
const DEFAULT_MAX_MODELS = 1000
const DEFAULT_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const num = (v, name, dflt) => {
  if (v === undefined || v === true) return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number`)
  return n
}
// printable model ids only: no control chars/newlines/quotes/backticks (they are echoed into prompts by the slash command)
const MODEL_ID_RE = /^(?!\s)[\p{L}\p{N}._:@+/()[\] -]{1,128}(?<!\s)$/u

// --------------------------------------------------------------------------
// paths
// --------------------------------------------------------------------------
export function paths(env = process.env) {
  const home = env.HOME || os.homedir()
  const configDir = env.OPENCODE_CP_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
  const dataDir = path.join(configDir, "custom-providers")
  return {
    home,
    configDir,
    dataDir,
    registry: path.join(dataDir, "registry.json"),
    keyFile: (id) => path.join(dataDir, `${id}.key`),
    modelsCache: (id) => path.join(dataDir, `${id}.models.json`),
    commandFile: path.join(configDir, "commands", "custom-provider.md"),
    relayState: path.join(dataDir, "relay.json"),
    relayLog: path.join(dataDir, "relay.log"),
    paused: path.join(dataDir, "paused.json"),
  }
}

// --------------------------------------------------------------------------
// small utils
// --------------------------------------------------------------------------
export class CliError extends Error {}
export class NoModelListError extends CliError {}
const fail = (msg) => {
  throw new CliError(msg)
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}

export function normalizeBaseURL(raw) {
  let s = String(raw || "").trim()
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.)/.test(s) ? "http://" : "https://") + s
    else fail(`Invalid base URL: ${raw}`)
  }
  let u
  try {
    u = new URL(s)
  } catch {
    fail(`Invalid base URL: ${raw}`)
  }
  u.hash = ""
  u.search = ""
  return u.toString().replace(/\/+$/, "")
}

export function maskKey(key) {
  if (!key) return "(none)"
  if (key.length <= 8) return "****"
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

// Strip comments / trailing commas so opencode.jsonc can be parsed.
export function parseJsonc(text) {
  let out = ""
  let i = 0
  const n = text.length
  let inStr = false
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += d ?? ""
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
    } else if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++
    } else if (c === "/" && d === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return out.trim() === "" ? {} : JSON.parse(out)
}

const hasComments = (text) => {
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

function atomicWrite(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, { mode: mode ?? 0o644 })
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --------------------------------------------------------------------------
// config + registry
// --------------------------------------------------------------------------
export function locateConfig(P) {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const f = path.join(P.configDir, name)
    if (fs.existsSync(f)) return f
  }
  return path.join(P.configDir, "opencode.json")
}

export function loadConfig(P) {
  const file = locateConfig(P)
  if (!fs.existsSync(file)) return { file, cfg: {}, raw: "", existed: false }
  const raw = fs.readFileSync(file, "utf8")
  let cfg
  try {
    cfg = parseJsonc(raw)
  } catch (e) {
    fail(`Cannot parse ${file}: ${e.message}\nFix the file first; nothing was changed.`)
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) fail(`${file} is not a JSON object; nothing was changed.`)
  return { file, cfg, raw, existed: true }
}

// Everything except the managed provider ids must be identical after the edit.
function assertInvariant(before, after, managedIds) {
  const strip = (cfg) => {
    const c = JSON.parse(JSON.stringify(cfg))
    if (c.provider) for (const id of managedIds) delete c.provider[id]
    if (c.provider && Object.keys(c.provider).length === 0) delete c.provider
    for (const k of ["enabled_providers", "disabled_providers"]) if (Array.isArray(c[k])) c[k] = c[k].filter((x) => !managedIds.includes(x))
    delete c.$schema
    return c
  }
  if (!deepEqual(strip(before), strip(after))) fail("Internal safety check failed: unrelated config would change. Nothing was written.")
  if (after.provider?.opencode && !deepEqual(before.provider?.opencode, after.provider.opencode)) fail("Internal safety check failed: OpenCode Zen entry would change.")
}

// OpenCode 2.x turns `enabled_providers` into "deny every provider except these": a new provider that is
// not listed there is silently hidden (models never appear). Keep our ids allowed.
export function allowProvider(cfg, id) {
  let touched = false
  if (Array.isArray(cfg.enabled_providers) && !cfg.enabled_providers.includes(id)) {
    cfg.enabled_providers.push(id)
    touched = true
  }
  if (Array.isArray(cfg.disabled_providers) && cfg.disabled_providers.includes(id)) {
    cfg.disabled_providers = cfg.disabled_providers.filter((x) => x !== id)
    touched = true
  }
  return touched
}

export function saveConfig(P, loaded, mutate, managedIds) {
  const before = JSON.parse(JSON.stringify(loaded.cfg))
  const after = JSON.parse(JSON.stringify(loaded.cfg))
  mutate(after)
  assertInvariant(before, after, managedIds)
  if (!loaded.existed && !after.$schema) after.$schema = "https://opencode.ai/config.json"
  if (loaded.existed) {
    const bak = `${loaded.file}.bak-custom-provider`
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(loaded.file, bak)
      if (hasComments(loaded.raw)) console.error(`note: ${path.basename(loaded.file)} contained comments/trailing commas; they are dropped on rewrite. Original saved as ${bak}`)
    }
  }
  atomicWrite(loaded.file, JSON.stringify(after, null, 2) + "\n")
  return after
}

export const loadRegistry = (P) => readJson(P.registry, { version: 1, providers: {} })
const saveRegistry = (P, reg) => atomicWrite(P.registry, JSON.stringify(reg, null, 2) + "\n", 0o600)

// --------------------------------------------------------------------------
// keys
// --------------------------------------------------------------------------
const tildePath = (P, file) => (file.startsWith(P.home + path.sep) ? "~" + file.slice(P.home.length) : file)

function writeKey(P, id, key) {
  atomicWrite(P.keyFile(id), key.trim(), 0o600)
}

function readKey(P, id) {
  try {
    return fs.readFileSync(P.keyFile(id), "utf8").trim()
  } catch {
    return ""
  }
}

function resolveKeyFromFlags(flags, env = process.env) {
  if (flags["no-key"]) return { none: true }
  if (flags.key) return { key: String(flags.key), viaArgv: true }
  if (flags["key-env"]) {
    const v = env[String(flags["key-env"])]
    if (!v) fail(`Environment variable ${flags["key-env"]} is empty or not set.`)
    return { key: v }
  }
  if (flags["key-file"]) {
    try {
      return { key: fs.readFileSync(String(flags["key-file"]), "utf8").trim() }
    } catch (e) {
      fail(`Cannot read key file: ${e.message}`)
    }
  }
  if (flags["key-clipboard"]) {
    try {
      return { key: execFileSync("termux-clipboard-get", { encoding: "utf8", timeout: 5000 }).trim() }
    } catch {
      fail("termux-clipboard-get failed. Install Termux:API (pkg install termux-api) and its Android app.")
    }
  }
  return {}
}

// --------------------------------------------------------------------------
// model fetching
// --------------------------------------------------------------------------
export function extractModels(body) {
  const arr = (v) => (Array.isArray(v) ? v : undefined)
  let list = arr(body) || arr(body?.data) || arr(body?.models) || arr(body?.result) || arr(body?.items) || arr(body?.data?.models) || arr(body?.data?.data)
  if (!list && body && typeof body === "object") {
    // object keyed by model id: { "gpt-4": {...} } (optionally under data/models)
    const m = [body.data, body.models, body].find((v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && Object.values(v).every((x) => x && typeof x === "object"))
    if (m && !body.error) list = Object.entries(m).map(([id, v]) => ({ id: v.id ?? id, ...v }))
  }
  const out = []
  for (const m of list || []) {
    const id = typeof m === "string" ? m : (m?.id ?? m?.name ?? m?.model)
    if (typeof id === "string") out.push({ id, raw: typeof m === "object" ? m : undefined })
  }
  return out
}
export const extractModelIds = (body) => extractModels(body).map((m) => m.id)

// What the PROVIDER says about a model (think effort differs per model, so we follow the provider).
// Only explicit/positive signals are used; a missing field never disables anything.
const EFFORT_NAMES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
const posInt = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
export function deriveMeta(raw) {
  if (!raw || typeof raw !== "object") return {}
  const caps = raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {}
  const sp = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined
  const bool = (...vs) => vs.find((v) => typeof v === "boolean")
  const effortSrc = [raw.reasoning_efforts, raw.supported_reasoning_efforts, raw.reasoning_effort_options, caps.reasoning_efforts].find(Array.isArray)
  const efforts = effortSrc?.map((e) => String(e).toLowerCase()).filter((e) => EFFORT_NAMES.includes(e))
  let reasoning = bool(raw.reasoning, raw.supports_reasoning, raw.thinking, caps.reasoning, caps.thinking, caps.supports_reasoning)
  if (reasoning === undefined && sp?.some((p) => /^(reasoning|include_reasoning|reasoning_effort)$/.test(p))) reasoning = true
  if (reasoning === undefined && efforts?.length) reasoning = true
  let tools = bool(raw.supports_function_calling, raw.supports_tool_calls, raw.tool_call, caps.tools, caps.function_calling, caps.tool_call)
  if (tools === undefined && sp?.includes("tools")) tools = true
  return {
    reasoning,
    efforts: efforts?.length ? [...new Set(efforts)] : undefined,
    tools,
    context: posInt(raw.context_length ?? raw.context_window ?? raw.max_context_length ?? raw.max_input_tokens ?? caps.context_length),
    output: posInt(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.top_provider?.max_completion_tokens ?? caps.max_output_tokens),
  }
}

export function selectModels(ids, { filter, max = DEFAULT_MAX_MODELS } = {}) {
  let re = null
  if (filter) {
    try {
      re = new RegExp(filter, "i")
    } catch {
      fail(`Invalid --filter regex: ${filter}`)
    }
  }
  const seen = new Set()
  let skipped = 0
  const clean = []
  for (const id of ids) {
    if (!MODEL_ID_RE.test(id)) {
      skipped++ // also blocks prompt-injection text smuggled in via model ids
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    if (re && !re.test(id)) continue
    clean.push(id)
  }
  clean.sort((a, b) => a.localeCompare(b))
  const truncated = clean.length > max
  return { ids: clean.slice(0, max), total: clean.length, truncated, skipped }
}

async function fetchJson(url, key, headers, timeoutMs, fetchImpl) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    })
    if (!res.ok) return { status: res.status }
    const text = await res.text()
    if (text.length > MAX_BODY_BYTES) fail("Model list response is too large (>5MB).")
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, notJson: true }
    }
  } catch (e) {
    if (e?.name === "AbortError") fail(`Timed out after ${timeoutMs / 1000}s fetching ${url}`)
    if (e instanceof CliError) throw e
    fail(`Network error for ${url}: ${e?.cause?.code || e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
}

// Returns { baseURL, ids, meta } -- baseURL may be corrected (adds /v1 if that is what works).
export async function fetchModels(baseURL, key, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const candidates = [baseURL]
  if (!/\/v\d+$/.test(baseURL)) candidates.push(`${baseURL}/v1`)
  let lastStatus = 0
  for (const base of candidates) {
    const r = await fetchJson(`${base}/models`, key, headers, timeoutMs, fetchImpl)
    lastStatus = r.status
    if (r.body) {
      const models = extractModels(r.body)
      if (models.length) return { baseURL: base, ids: models.map((m) => m.id), meta: new Map(models.map((m) => [m.id, deriveMeta(m.raw)])) }
      continue
    }
    if (r.status === 401 || r.status === 403) fail(`Authentication failed (HTTP ${r.status}). Check the API key.`)
    if (r.status === 429) fail("Rate limited (HTTP 429). Try again shortly.")
  }
  throw new NoModelListError(`Could not read a model list from ${baseURL}/models (last status ${lastStatus || "n/a"}).`)
}

// --------------------------------------------------------------------------
// provider ops
// --------------------------------------------------------------------------
// Models that are known/likely to accept a reasoning effort. Used only for the `auto` mode;
// force with --reasoning, disable with --no-reasoning.
const REASONING_RE = /(^|[/:_-])(o[134](-|$)|gpt-5|gpt-oss|r1(-|$)|reasoner|qwq|qwen3|thinking|magistral|glm-(4\.[5-9]|[5-9])|kimi-k2|deepseek-v[34]|grok-[34]|claude-(opus|sonnet)|gemini-(2\.5|3))/i
export const looksReasoning = (id) => REASONING_RE.test(id)
const reasoningFor = (id, mode) => (mode === "on" ? true : mode === "off" ? false : looksReasoning(id))

// New models get `tool_call: true` (agentic tool use) unless --no-tools. Think effort follows the provider:
//   provider metadata (explicit reasoning flag / effort list)  >  model-id heuristic  >  nothing.
// Existing entries are preserved; only MISSING keys are filled, anything the user set is never overwritten.
function buildModelsMap(existing, ids, { tools = true, reasoning = "auto", meta = new Map() } = {}) {
  const fill = (entry, id) => {
    const m = meta.get(id) || {}
    const reasons = reasoning === "on" ? true : reasoning === "off" ? false : (m.reasoning ?? looksReasoning(id))
    if (entry.tool_call === undefined && tools) entry.tool_call = m.tools === false ? false : true
    if (entry.reasoning === undefined) {
      if (reasons) entry.reasoning = true
      else if (reasoning === "auto" && m.reasoning === false) entry.reasoning = false // provider said so explicitly
    }
    if (entry.variants === undefined) {
      if (entry.reasoning === true && m.efforts && reasoning !== "off") entry.variants = Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }]))
      else if (reasoning === "auto" && m.reasoning === false) entry.variants = {} // no effort variants for non-reasoning models
    }
    if (entry.limit === undefined && m.context && m.output) entry.limit = { context: m.context, output: Math.min(m.output, m.context) }
    return entry
  }
  const map = {}
  for (const id of ids) {
    const cur = existing?.[id]
    map[id] = fill(cur && typeof cur === "object" ? { ...cur } : { name: id }, id)
  }
  // keep user-customised entries (anything beyond what this tool generates) even if the server dropped them
  for (const [id, v] of Object.entries(existing || {})) if (!(id in map) && v && Object.keys(v).some((k) => !["name", "tool_call", "reasoning", "variants", "limit"].includes(k))) map[id] = v
  return map
}

const reasoningMode = (flags) => (flags["no-reasoning"] ? "off" : flags.reasoning ? "on" : "auto")

function parseHeaders(list) {
  const out = {}
  for (const h of [].concat(list || [])) {
    const i = String(h).indexOf("=")
    if (i < 1) fail(`Invalid --header "${h}" (use Name=Value)`)
    out[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim()
  }
  return out
}

function describe(id, entry, P, reg) {
  const n = Object.keys(entry.models || {}).length
  const key = readKey(P, id)
  return `${id}  "${entry.name}"  ${entry.options?.baseURL}  models=${n}  key=${key ? "set" : "none"}${reg?.providers?.[id]?.upstream ? "  relay=on" : ""}`
}

export async function cmdAdd(P, args, flags, io, deps = {}) {
  const pos = [...args]
  let url = flags.url
  if (!url) {
    const i = pos.findIndex((a) => /^(https?:\/\/|localhost|127\.|\d+\.\d+\.\d+\.\d+)/i.test(a))
    if (i >= 0) url = pos.splice(i, 1)[0]
  }
  const name = String(flags.name || pos.join(" ")).trim()
  if (!name) fail("Missing provider name.\nUsage: add <name> <baseURL> [--key-env VAR | --key-file F | --key-clipboard | --no-key]")
  if (!url) fail("Missing base URL.\nUsage: add <name> <baseURL> [--key-env VAR | --key-file F | --key-clipboard | --no-key]")
  const id = slugify(flags.id || name)
  if (!id) fail("Could not derive a provider id from the name; pass --id.")
  if (RESERVED_IDS.has(id)) fail(`"${id}" is a built-in provider id${id === "opencode" ? " (OpenCode Zen) and is never modified" : ""}. Choose another name or pass --id.`)

  const loaded = loadConfig(P)
  const reg = loadRegistry(P)
  if (loaded.cfg.provider?.[id] && !reg.providers[id]) fail(`A provider "${id}" already exists in ${loaded.file} and was not created by this tool. Pick another name/--id.`)
  if (reg.providers[id] && !flags.force) fail(`Provider "${id}" already exists. Use "set ${id} ..." to change it or "remove ${id}" first (or pass --force).`)

  const existingEntry = flags.force ? loaded.cfg.provider?.[id] : undefined
  let baseURL = normalizeBaseURL(url)
  let keyInfo = resolveKeyFromFlags(flags, deps.env)
  if (keyInfo.key === undefined && !keyInfo.none && io.interactive) {
    keyInfo = { key: await io.ask("API key (hidden, empty for none): ", { hidden: true }) }
  }
  const key = keyInfo.key || ""
  const headers = parseHeaders(flags.header)
  if (keyInfo.viaArgv) io.warn("Key was passed on the command line. Inside OpenCode that lands in your session history and is sent to the model provider. Prefer --key-env, --key-file, --key-clipboard or the interactive wizard.")

  let ids = []
  let meta = new Map()
  let info = ""
  if (flags.models) {
    ids = String(flags.models).split(",").map((s) => s.trim()).filter(Boolean)
  } else if (!flags["no-fetch"]) {
    let r = null
    try {
      r = await fetchModels(baseURL, key, { headers, timeoutMs: num(flags.timeout, "timeout", DEFAULT_TIMEOUT_MS / 1000) * 1000, fetchImpl: deps.fetchImpl })
    } catch (e) {
      // the server answered but has no usable /models list: still add the provider so models can be added by hand
      if (!(e instanceof NoModelListError)) throw e
      info += `warning: ${e.message}\nThe provider is added WITHOUT models. Add them with:  set ${id} --models model-a,model-b\n`
    }
    if (r) {
      if (r.baseURL !== baseURL) info += `base URL corrected to ${r.baseURL}\n`
      baseURL = r.baseURL
      const sel = selectModels(r.ids, { filter: flags.filter, max: num(flags.max, "max", DEFAULT_MAX_MODELS) })
      ids = sel.ids
      meta = r.meta
      info += modelSummary(sel)
      fs.mkdirSync(P.dataDir, { recursive: true })
      atomicWrite(P.modelsCache(id), JSON.stringify({ fetchedAt: new Date().toISOString(), ids: r.ids.filter((x) => MODEL_ID_RE.test(x)) }) + "\n")
    }
  }

  const hadKey = fs.existsSync(P.keyFile(id))
  if (key) writeKey(P, id, key) // key file first: config must never reference a missing file
  const entry = {
    npm: NPM_PKG,
    name,
    options: {
      ...(existingEntry?.options || {}),
      baseURL,
      ...(key ? { apiKey: `{file:${tildePath(P, P.keyFile(id))}}` } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    },
    models: buildModelsMap(existingEntry?.models, ids, { tools: !flags["no-tools"], reasoning: reasoningMode(flags), meta }),
  }
  if (!key) delete entry.options.apiKey
  let allowed = false
  try {
    saveConfig(P, loaded, (cfg) => {
      cfg.provider = cfg.provider || {}
      cfg.provider[id] = entry
      allowed = allowProvider(cfg, id)
    }, [id])
  } catch (e) {
    if (key && !hadKey) fs.rmSync(P.keyFile(id), { force: true })
    throw e
  }
  if (!key && fs.existsSync(P.keyFile(id))) fs.rmSync(P.keyFile(id)) // config no longer references it
  reg.providers[id] = { name, createdAt: new Date().toISOString() }
  saveRegistry(P, reg)

  io.out(`${info}Added provider "${name}" (id: ${id}) with ${ids.length} model(s).`)
  if (allowed) io.out(`note: your config has enabled_providers/disabled_providers; "${id}" was added to the allow-list so it is not hidden.`)
  if (!ids.length) io.out(`No models yet. Run: models ${id}   (or: set ${id} --models a,b)`)
  io.out(`Use it in OpenCode as ${id}/<model>. Restart OpenCode to load it. OpenCode Zen is untouched.`)
}

function modelSummary(sel) {
  let s = `Fetched ${sel.total} model(s)`
  if (sel.skipped) s += `, skipped ${sel.skipped} with unsafe ids`
  s += ".\n"
  if (sel.truncated) s += `Kept the first ${sel.ids.length}. Use --filter <regex> (or --max N) to choose which; \n`
  return s
}

export async function cmdModels(P, args, flags, io, deps = {}) {
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const wanted = flags.all || !args.length ? Object.keys(reg.providers) : args.map((a) => slugify(a))
  if (!wanted.length) fail("No custom providers yet. Add one with: add <name> <baseURL>")
  for (const id of wanted) if (!reg.providers[id] || !loaded.cfg.provider?.[id]) fail(`Unknown custom provider "${id}". Run "list".`)

  // fetch in parallel (always from the real upstream, never through the relay); apply sequentially
  const results = await Promise.allSettled(
    wanted.map(async (id) => {
      const entry = loaded.cfg.provider[id]
      const r = await fetchModels(reg.providers[id].upstream || entry.options.baseURL, readKey(P, id), {
        headers: entry.options.headers || {},
        timeoutMs: num(flags.timeout, "timeout", DEFAULT_TIMEOUT_MS / 1000) * 1000,
        fetchImpl: deps.fetchImpl,
      })
      return { id, r }
    }),
  )
  const updates = []
  results.forEach((res, i) => {
    if (res.status === "rejected") io.out(`${wanted[i]}: ${res.reason?.message || res.reason}`)
    else updates.push(res.value)
  })
  if (!updates.length) throw new CliError("No provider could be refreshed.")

  const lines = []
  const save = flags["dry-run"] ? (_P, l, m) => m(JSON.parse(JSON.stringify(l.cfg))) : saveConfig
  let regChanged = false
  save(P, loaded, (cfg) => {
    for (const { id, r } of updates) {
      const entry = cfg.provider[id]
      const sel = selectModels(r.ids, { filter: flags.filter, max: num(flags.max, "max", DEFAULT_MAX_MODELS) })
      const before = Object.keys(entry.models || {})
      if (!flags["dry-run"]) {
        if (reg.providers[id].upstream) {
          if (reg.providers[id].upstream !== r.baseURL) {
            reg.providers[id].upstream = r.baseURL
            regChanged = true
          }
        } else entry.options.baseURL = r.baseURL
        entry.models = buildModelsMap(entry.models, sel.ids, { tools: !flags["no-tools"], reasoning: reasoningMode(flags), meta: r.meta })
        fs.mkdirSync(P.dataDir, { recursive: true })
        atomicWrite(P.modelsCache(id), JSON.stringify({ fetchedAt: new Date().toISOString(), ids: r.ids.filter((x) => MODEL_ID_RE.test(x)) }) + "\n")
      }
      const after = Object.keys(flags["dry-run"] ? Object.fromEntries(sel.ids.map((x) => [x, 1])) : entry.models)
      const added = after.filter((x) => !before.includes(x)).length
      const removed = before.filter((x) => !after.includes(x)).length
      const reasoningCount = flags["dry-run"] ? "?" : Object.values(entry.models).filter((m) => m.reasoning === true).length
      lines.push(`${id}: ${after.length} model(s) (+${added} / -${removed}), reasoning=${reasoningCount}${sel.truncated ? " [truncated; use --filter]" : ""}${sel.skipped ? ` [${sel.skipped} unsafe ids skipped]` : ""}`)
      if (flags.list || flags["dry-run"]) lines.push(...sel.ids.map((x) => `  - ${x}`))
    }
  }, updates.map((u) => u.id))
  if (regChanged) saveRegistry(P, reg)
  io.out(lines.join("\n") + (flags["dry-run"] ? "\n(dry run: nothing written)" : "\nRestart OpenCode to reload models."))
}

export function cmdList(P, io) {
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const paused = readJson(P.paused, { providers: {} }).providers
  const ids = Object.keys(reg.providers).filter((id) => loaded.cfg.provider?.[id] || paused[id])
  if (!ids.length) return io.out("No custom providers. Add one: add <name> <baseURL> [--key-env VAR]")
  io.out(ids.map((id) => describe(id, loaded.cfg.provider?.[id] || paused[id], P, reg) + (loaded.cfg.provider?.[id] ? "" : "  PAUSED")).join("\n"))
}

export async function cmdSet(P, args, flags, io, deps = {}) {
  const id = slugify(args[0] || "")
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  if (!id || !reg.providers[id] || !loaded.cfg.provider?.[id]) fail(`Unknown custom provider "${args[0] || ""}". Run "list".`)
  const relay = flags.relay === undefined ? undefined : String(flags.relay).toLowerCase()
  if (relay !== undefined && relay !== "on" && relay !== "off") fail("--relay must be on or off")
  const keyInfo = resolveKeyFromFlags(flags, deps.env)
  if (keyInfo.viaArgv) io.warn("Key was passed on the command line (it ends up in shell/session history). Prefer --key-env / --key-file / --key-clipboard.")
  let newKey = keyInfo.key
  if (newKey === undefined && !keyInfo.none && !flags.name && !flags["base-url"] && !flags.header && !flags.models && relay === undefined && io.interactive) newKey = await io.ask("New API key (hidden, empty to keep): ", { hidden: true })
  const headers = flags.header ? parseHeaders(flags.header) : null
  const regEntry = reg.providers[id]
  const newBase = flags["base-url"] ? normalizeBaseURL(flags["base-url"]) : undefined
  reg.relay = reg.relay || { port: num(flags.port, "port", DEFAULT_RELAY_PORT) }
  const manual = flags.models ? String(flags.models).split(",").map((x) => x.trim()).filter(Boolean) : []
  for (const m of manual) if (!MODEL_ID_RE.test(m)) fail(`Invalid model id: ${m}`)
  saveConfig(P, loaded, (cfg) => {
    const e = cfg.provider[id]
    allowProvider(cfg, id)
    if (manual.length) e.models = { ...buildModelsMap(e.models, manual, { tools: !flags["no-tools"], reasoning: reasoningMode(flags) }), ...Object.fromEntries(Object.entries(e.models || {}).filter(([k]) => !manual.includes(k))) }
    if (flags.name) e.name = String(flags.name)
    // upstream = the real server. While the relay is on, config points at the relay instead.
    let upstream = regEntry.upstream
    if (newBase) {
      if (upstream) upstream = newBase
      else e.options.baseURL = newBase
    }
    if (relay === "on") {
      upstream = upstream || e.options.baseURL
      e.options.baseURL = relayURL(reg, id)
    } else if (relay === "off" && upstream) {
      e.options.baseURL = upstream
      upstream = undefined
    }
    if (upstream) regEntry.upstream = upstream
    else delete regEntry.upstream
    if (headers) e.options.headers = { ...(e.options.headers || {}), ...headers }
    if (keyInfo.none) {
      delete e.options.apiKey
    } else if (newKey) {
      writeKey(P, id, newKey)
      e.options.apiKey = `{file:${tildePath(P, P.keyFile(id))}}`
    }
  }, [id])
  if (keyInfo.none && fs.existsSync(P.keyFile(id))) fs.rmSync(P.keyFile(id))
  if (flags.name) regEntry.name = String(flags.name)
  saveRegistry(P, reg)
  let msg = `Updated "${id}". ` + (manual.length ? `Added ${manual.length} model(s). ` : "") + (newBase ? "Run: models " + id + "  to refresh the model list. " : "") + "Restart OpenCode to apply."
  if (relay === "on") {
    msg += `\nRelay is ON for "${id}" (fixes servers that stream content after finish_reason). ` + (deps.noSpawn ? "" : await ensureRelay(P, io))
    msg += `\nStart OpenCode with: opencode-custom-provider launch   (starts the relay automatically)`
  }
  io.out(msg)
}

export function cmdRemove(P, args, flags, io) {
  const id = slugify(args[0] || "")
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  if (!id || !reg.providers[id]) fail(`Unknown custom provider "${args[0] || ""}". Run "list".`)
  saveConfig(P, loaded, (cfg) => {
    if (cfg.provider) {
      delete cfg.provider[id]
      if (Object.keys(cfg.provider).length === 0) delete cfg.provider
    }
    if (Array.isArray(cfg.enabled_providers)) cfg.enabled_providers = cfg.enabled_providers.filter((x) => x !== id)
  }, [id])
  for (const f of [P.keyFile(id), P.modelsCache(id)]) if (fs.existsSync(f)) fs.rmSync(f)
  delete reg.providers[id]
  saveRegistry(P, reg)
  io.out(`Removed "${id}" (config entry, key file, model cache). OpenCode Zen and other providers are untouched.`)
}

// --------------------------------------------------------------------------
// stream relay: fixes servers that send content AFTER finish_reason
// --------------------------------------------------------------------------
// OpenCode 2.x rejects such streams ("OpenAI Chat received content after the finish reason").
// The relay (127.0.0.1 only) forwards requests unchanged but holds back finish_reason and emits it
// once, just before [DONE]. It never reads API keys: OpenCode sends the Authorization header itself.
export function createSSENormalizer() {
  let buf = ""
  let pending = null
  let meta = {}
  const finishChunk = () => {
    const chunk = { id: meta.id ?? "relay", object: "chat.completion.chunk", created: meta.created ?? Math.floor(Date.now() / 1000), model: meta.model ?? "", choices: [{ index: 0, delta: {}, finish_reason: pending.finish_reason }] }
    if (pending.native_finish_reason !== undefined) chunk.choices[0].native_finish_reason = pending.native_finish_reason
    pending = null
    return `data: ${JSON.stringify(chunk)}\n\n`
  }
  const event = (raw) => {
    const lines = raw.split("\n")
    const di = lines.findIndex((l) => l.startsWith("data:"))
    if (di < 0) return raw + "\n\n"
    const data = lines[di].slice(5).trim()
    if (data === "[DONE]") return (pending ? finishChunk() : "") + raw + "\n\n"
    let obj
    try {
      obj = JSON.parse(data)
    } catch {
      return raw + "\n\n"
    }
    if (obj && typeof obj === "object") {
      for (const k of ["id", "created", "model"]) if (obj[k] !== undefined) meta[k] = obj[k]
      const c = obj.choices?.[0]
      if (c && c.finish_reason) {
        pending = { finish_reason: c.finish_reason, native_finish_reason: c.native_finish_reason }
        c.finish_reason = null
        delete c.native_finish_reason
        lines[di] = "data: " + JSON.stringify(obj)
        return lines.join("\n") + "\n\n"
      }
    }
    return raw + "\n\n"
  }
  return {
    push(text) {
      buf += text.replace(/\r\n/g, "\n")
      let out = ""
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (raw.trim()) out += event(raw)
      }
      return out
    },
    end() {
      let out = buf.trim() ? event(buf.trim()) : ""
      buf = ""
      if (pending) out += finishChunk()
      return out
    },
  }
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "host", "accept-encoding", "upgrade", "te", "trailer"])

export function startRelay({ port = DEFAULT_RELAY_PORT, host = "127.0.0.1", getUpstream, fetchImpl = globalThis.fetch }) {
  const server = http.createServer(async (req, res) => {
    const ctl = new AbortController()
    res.on("close", () => ctl.abort())
    try {
      if (req.url === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok")
      const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(req.url || "")
      const upstream = m && getUpstream(m[1])
      if (!upstream) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unknown relay provider" } }))
      const chunks = []
      let size = 0
      for await (const c of req) {
        size += c.length
        if (size > 25 * 1024 * 1024) return void res.writeHead(413).end()
        chunks.push(c)
      }
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") headers[k] = v
      headers["accept-encoding"] = "identity"
      const hasBody = !["GET", "HEAD"].includes(req.method)
      const up = await fetchImpl(upstream + (m[2] || ""), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined, signal: ctl.signal })
      const out = {}
      up.headers.forEach((v, k) => {
        if (!HOP.has(k)) out[k] = v
      })
      res.writeHead(up.status, out)
      const stream = (up.headers.get("content-type") || "").includes("text/event-stream")
      const norm = stream ? createSSENormalizer() : null
      const dec = new TextDecoder()
      if (up.body) {
        for await (const chunk of up.body) {
          if (norm) {
            const t = norm.push(dec.decode(chunk, { stream: true }))
            if (t) res.write(t)
          } else res.write(chunk)
        }
      }
      if (norm) {
        const t = norm.end()
        if (t) res.write(t)
      }
      res.end()
    } catch (e) {
      if (ctl.signal.aborted) return
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `relay: upstream error: ${e?.cause?.code || e?.message || e}` } }))
    }
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve({ server, port: server.address().port }))
  })
}

const relayURL = (reg, id) => `http://127.0.0.1:${reg.relay?.port || DEFAULT_RELAY_PORT}/${id}`

function relayAlive(P) {
  const st = readJson(P.relayState, null)
  if (!st?.pid) return null
  try {
    process.kill(st.pid, 0)
    return st
  } catch {
    return null
  }
}

async function relayHealthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

export async function ensureRelay(P, io) {
  const reg = loadRegistry(P)
  const port = reg.relay?.port || DEFAULT_RELAY_PORT
  if (relayAlive(P) && (await relayHealthy(port))) return `Relay already running on 127.0.0.1:${port}.`
  fs.mkdirSync(P.dataDir, { recursive: true })
  const log = fs.openSync(P.relayLog, "w")
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "relay", "run", "--port", String(port)], { detached: true, stdio: ["ignore", log, log] })
  child.unref()
  atomicWrite(P.relayState, JSON.stringify({ pid: child.pid, port }) + "\n")
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150))
    if (await relayHealthy(port)) return `Relay started on 127.0.0.1:${port}.`
  }
  fail(`Relay did not start (see ${P.relayLog}). Is port ${port} in use? Try: relay start --port 18792`)
}

async function cmdRelay(P, args, flags, io, deps = {}) {
  const sub = args[0] || "status"
  const reg = loadRegistry(P)
  if (flags.port) {
    reg.relay = { port: num(flags.port, "port") }
    saveRegistry(P, reg)
  }
  const port = reg.relay?.port || DEFAULT_RELAY_PORT
  if (sub === "run") {
    const r = await startRelay({ port, getUpstream: (id) => loadRegistry(P).providers[id]?.upstream })
    console.log(`relay listening on 127.0.0.1:${r.port}`)
    return new Promise(() => {}) // keep serving
  }
  if (sub === "start") return io.out(await ensureRelay(P, io))
  if (sub === "stop") {
    const st = relayAlive(P)
    if (st) process.kill(st.pid)
    fs.rmSync(P.relayState, { force: true })
    return io.out(st ? "Relay stopped." : "Relay was not running.")
  }
  if (sub === "status") {
    const up = Object.entries(reg.providers).filter(([, v]) => v.upstream).map(([k]) => k)
    return io.out(`relay: ${relayAlive(P) && (await relayHealthy(port)) ? "running" : "stopped"} (127.0.0.1:${port}); providers using it: ${up.join(", ") || "none"}`)
  }
  fail(`Unknown relay command "${sub}" (start | stop | status | run)`)
}

// Start the relay if any provider needs it, then run opencode with the remaining args.
function cmdLaunch(P, rest, io) {
  const reg = loadRegistry(P)
  const needs = Object.values(reg.providers).some((v) => v.upstream)
  const go = () => {
    const r = spawnSync("opencode", rest, { stdio: "inherit" })
    if (r.error) {
      io.out(`error: cannot run opencode: ${r.error.message}`)
      return (process.exitCode = 127)
    }
    process.exitCode = r.status ?? 1
  }
  if (!needs) return go()
  return ensureRelay(P, io).then(go)
}

// --------------------------------------------------------------------------
// diagnose: does this server stream content after finish_reason?
// --------------------------------------------------------------------------
export function analyzeStream(text) {
  let finishedAt = -1
  let late = 0
  let events = 0
  let content = 0
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"))
    if (!line) continue
    const data = line.slice(5).trim()
    if (data === "[DONE]") continue
    let obj
    try {
      obj = JSON.parse(data)
    } catch {
      continue
    }
    events++
    const c = obj.choices?.[0]
    const d = c?.delta || {}
    const has = Boolean(d.content || d.refusal || d.reasoning_content || d.reasoning || (d.tool_calls || []).some((t) => t.id || t.function?.name || t.function?.arguments))
    if (has) content++
    if (finishedAt >= 0 && has) late++
    if (c?.finish_reason && finishedAt < 0) finishedAt = events
  }
  return { events, content, finishedAt, late }
}

async function cmdDiagnose(P, args, flags, io, deps = {}) {
  const id = slugify(args[0] || "")
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const entry = loaded.cfg.provider?.[id]
  if (!id || !reg.providers[id] || !entry) fail(`Unknown custom provider "${args[0] || ""}". Run "list".`)
  const model = flags.model || Object.keys(entry.models || {})[0]
  if (!model) fail("No model to test. Pass --model <id>.")
  const base = reg.providers[id].upstream || entry.options.baseURL
  const key = readKey(P, id)
  const fetchImpl = deps.fetchImpl || globalThis.fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), num(flags.timeout, "timeout", 30) * 1000)
  let res
  let text
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(entry.options.headers || {}) },
      body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 64, messages: [{ role: "user", content: "Say hello in five words." }] }),
    })
    text = await res.text()
  } catch (e) {
    fail(`Request failed: ${e?.name === "AbortError" ? "timeout" : e?.cause?.code || e?.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) fail(`Server answered HTTP ${res.status} for model "${model}". ${text.slice(0, 200).replace(/\s+/g, " ")}`)
  const a = analyzeStream(text)
  if (!a.events) fail(`Not an OpenAI-style event stream (no JSON chunks). First bytes: ${text.slice(0, 120).replace(/\s+/g, " ")}`)
  io.out(`model=${model}  chunks=${a.events}  content-chunks=${a.content}  finish_reason first seen at chunk ${a.finishedAt > 0 ? a.finishedAt : "never"}`)
  if (a.late > 0) io.out(`PROBLEM: ${a.late} content chunk(s) arrive AFTER finish_reason. OpenCode 2.x aborts with "received content after the finish reason".\nFix: opencode-custom-provider set ${id} --relay on   then start with: opencode-custom-provider launch`)
  else if (a.finishedAt < 0) io.out("WARNING: the stream never sent finish_reason. OpenCode may treat the reply as unfinished.")
  else io.out("OK: stream order is valid; the relay is not needed for this model.")
}

// --------------------------------------------------------------------------
// doctor: find out why a provider/model does not show up
// --------------------------------------------------------------------------
const CFG_NAMES = ["opencode.json", "opencode.jsonc"]

export function scanConfigs(P, cwd) {
  const files = CFG_NAMES.map((n) => path.join(P.configDir, n))
  let dir = path.resolve(cwd)
  for (let i = 0; i < 40; i++) {
    for (const n of CFG_NAMES) files.push(path.join(dir, n), path.join(dir, ".opencode", n))
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  const out = []
  for (const f of [...new Set(files)]) {
    if (!fs.existsSync(f)) continue
    const raw = fs.readFileSync(f, "utf8")
    const global = path.dirname(f) === P.configDir
    try {
      out.push({ file: f, raw, cfg: parseJsonc(raw), global })
    } catch (e) {
      out.push({ file: f, raw, error: e.message, global })
    }
  }
  return out
}

async function cmdDoctor(P, args, flags, io, deps = {}) {
  const reg = loadRegistry(P)
  const scans = scanConfigs(P, deps.cwd || process.cwd())
  const lines = []
  let problems = 0
  const bad = (m) => (problems++, lines.push("PROBLEM " + m))
  const ok = (m) => lines.push("ok      " + m)
  const note = (m) => lines.push("note    " + m)
  for (const sc of scans) if (sc.error) bad(`${sc.file} cannot be parsed: ${sc.error}`)
  const good = scans.filter((x) => x.cfg)
  const paused = readJson(P.paused, { providers: {} }).providers
  const main = loadConfig(P)
  const ids = args.length ? args.map((a) => slugify(a)) : Object.keys(reg.providers)
  if (!ids.length) note("no custom providers registered")
  const fixList = []
  for (const id of ids) {
    if (!reg.providers[id]) {
      bad(`${id}: not a custom provider of this tool (see: list)`)
      continue
    }
    const entry = main.cfg.provider?.[id]
    if (!entry) {
      paused[id] ? note(`${id}: PAUSED (run: resume)`) : bad(`${id}: registered but missing from ${main.file} (re-add it)`)
      continue
    }
    const n = Object.keys(entry.models || {}).length
    n ? ok(`${id}: ${n} model(s) in config (${main.file})`) : bad(`${id}: no models in config. Run: models ${id}   or: set ${id} --models a,b`)
    const m = /^\{file:(.+)\}$/.exec(entry.options?.apiKey || "")
    if (m) {
      const kf = m[1].startsWith("~") ? path.join(P.home, m[1].slice(1)) : m[1]
      fs.existsSync(kf) ? ok(`${id}: key file present`) : bad(`${id}: key file missing (${kf}); config would fail to load. Run: set ${id} --key-clipboard`)
    } else if (!entry.options?.apiKey) note(`${id}: no API key configured`)
    for (const sc of good) {
      const en = sc.cfg.enabled_providers
      if (Array.isArray(en) && !en.includes(id)) {
        bad(`${id}: HIDDEN by enabled_providers in ${sc.file} (OpenCode only shows the providers listed there)`)
        if (sc.global) fixList.push({ sc, id })
        else lines.push(`        fix by hand: add "${id}" to enabled_providers in that file`)
      }
      if (Array.isArray(sc.cfg.disabled_providers) && sc.cfg.disabled_providers.includes(id)) {
        bad(`${id}: HIDDEN by disabled_providers in ${sc.file}`)
        if (sc.global) fixList.push({ sc, id })
      }
      if (Array.isArray(sc.cfg.policies) && sc.cfg.policies.some((x) => x?.action === "provider.use" && x?.effect === "deny" && (x.resource === "*" || x.resource === id)))
        bad(`${id}: a policy in ${sc.file} denies provider.use for it`)
      if (sc.file !== main.file && sc.cfg.provider?.[id]) note(`${id}: also defined in ${sc.file}; the two definitions are merged`)
    }
    if (!flags.offline) {
      try {
        const base = reg.providers[id].upstream || entry.options.baseURL
        const r = await fetchModels(base, readKey(P, id), { headers: entry.options.headers || {}, timeoutMs: 8000, fetchImpl: deps.fetchImpl })
        ok(`${id}: server answers, lists ${r.ids.length} model(s)`)
      } catch (e) {
        bad(`${id}: ${e.message}`)
      }
    }
    if (reg.providers[id].upstream) {
      const port = reg.relay?.port || DEFAULT_RELAY_PORT
      if (await relayHealthy(port)) ok(`${id}: relay running on 127.0.0.1:${port}`)
      else {
        bad(`${id}: relay is ON but not running -> opencode cannot reach the server. Run: relay start (or start opencode with: launch)`)
        fixList.push({ relay: true })
      }
    }
  }
  if (flags.fix && fixList.length) {
    for (const f of fixList) {
      if (f.relay) {
        if (!deps.noSpawn) lines.push("fixed   " + (await ensureRelay(P, io)))
      } else {
        saveConfig(P, { file: f.sc.file, cfg: f.sc.cfg, raw: f.sc.raw, existed: true }, (cfg) => allowProvider(cfg, f.id), [f.id])
        lines.push(`fixed   ${f.id}: allowed in ${f.sc.file}`)
      }
    }
    lines.push("Restart OpenCode to apply.")
  } else if (fixList.length) lines.push("Run again with --fix to repair what can be repaired automatically.")
  if (!deps.noSpawn) {
    const v = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 })
    note(v.error ? "opencode not found in PATH" : `opencode ${String(v.stdout).trim().split("\n")[0]}`)
  }
  lines.push(problems ? `${problems} problem(s) found.` : "No problems found.")
  io.out(lines.join("\n"))
}

// pause/resume: take every custom provider out of the config (and back) -- an A/B switch to check
// whether a problem comes from this add-on or from OpenCode itself (built-in providers/Zen).
function cmdPause(P, io) {
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const ids = Object.keys(reg.providers).filter((id) => loaded.cfg.provider?.[id])
  if (!ids.length) return io.out("Nothing to pause.")
  const paused = readJson(P.paused, { providers: {} })
  for (const id of ids) paused.providers[id] = loaded.cfg.provider[id]
  atomicWrite(P.paused, JSON.stringify(paused, null, 2) + "\n", 0o600) // stash first, then remove
  saveConfig(P, loaded, (cfg) => {
    for (const id of ids) delete cfg.provider[id]
    if (Object.keys(cfg.provider).length === 0) delete cfg.provider
  }, ids)
  io.out(`Paused ${ids.length} custom provider(s): ${ids.join(", ")}.\nOpenCode now sees only its built-in providers (including Zen). Restart it and test; then run: resume`)
}

function cmdResume(P, io) {
  const paused = readJson(P.paused, { providers: {} })
  const ids = Object.keys(paused.providers)
  if (!ids.length) return io.out("Nothing is paused.")
  const loaded = loadConfig(P)
  saveConfig(P, loaded, (cfg) => {
    cfg.provider = cfg.provider || {}
    for (const id of ids) {
      if (!cfg.provider[id]) cfg.provider[id] = paused.providers[id]
      allowProvider(cfg, id)
    }
  }, ids)
  fs.rmSync(P.paused, { force: true })
  io.out(`Resumed ${ids.length} custom provider(s): ${ids.join(", ")}. Restart OpenCode.`)
}

// --------------------------------------------------------------------------
// slash command installer (/custom-provider)
// --------------------------------------------------------------------------
export const COMMAND_MD = `---
description: Custom OpenAI-compatible providers (add / list / models / set / remove)
---
Run the shell command below and reply with its output exactly as printed.
Do not call any other tool, do not add commentary, and never repeat or guess an API key.

!\`opencode-custom-provider $ARGUMENTS\`
`

function cmdInstallCommand(P, io) {
  atomicWrite(P.commandFile, COMMAND_MD)
  io.out(`Installed /custom-provider -> ${P.commandFile}\nRestart OpenCode, then try: /custom-provider list`)
}

function cmdUninstallCommand(P, io) {
  if (fs.existsSync(P.commandFile)) fs.rmSync(P.commandFile)
  io.out("Removed /custom-provider command (providers are kept).")
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
export function parseArgs(argv) {
  const flags = {}
  const args = []
  const BOOL = new Set(["no-key", "no-fetch", "key-clipboard", "all", "list", "dry-run", "force", "help", "no-tools", "reasoning", "no-reasoning", "fix", "offline"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const k = a.slice(2, eq < 0 ? undefined : eq)
      let v = eq < 0 ? undefined : a.slice(eq + 1)
      if (BOOL.has(k)) v = v === undefined ? true : v !== "false"
      else if (v === undefined) {
        v = argv[++i]
        if (v === undefined) fail(`Missing value for --${k}`)
      }
      if (k === "header") flags.header = [...(flags.header || []), v]
      else flags[k] = v
    } else args.push(a)
  }
  return { args, flags }
}

export const HELP = `opencode-custom-provider -- OpenAI-compatible custom providers for OpenCode (Termux)

  add <name> <baseURL> [options]   create a provider and fetch its models
  list                             show custom providers
  models [id ...|--all] [options]  re-fetch the model list (--list to print, --dry-run to preview)
  set <id> [options]               change --name / --base-url / key / --header / --models a,b (add models by hand)
  remove <id>                      delete provider, key file and model cache
  doctor [id] [--fix] [--offline]   find why a provider/model is not shown (hidden by enabled_providers, missing key file, relay down...)
  pause | resume                   remove/restore all custom providers (A/B test against built-in providers like Zen)
  diagnose <id> [--model M]        test the stream order of a provider (finds "content after finish reason")
  set <id> --relay on|off          local relay that fixes servers streaming content after finish_reason
  relay start|stop|status          manage the relay;  launch [opencode args]  starts relay + opencode
  install-command | uninstall-command
                                   add/remove the /custom-provider slash command

key options:  --key-env VAR | --key-file PATH | --key-clipboard | --no-key | --key VALUE (not recommended)
other:        --no-tools  --reasoning | --no-reasoning (think effort; default: auto by model id)  --id ID  --models a,b,c  --no-fetch  --filter REGEX  --max N  --timeout SEC  --header Name=Value

OpenCode Zen (provider id "opencode") and all other config entries are never modified.
Inside OpenCode: /custom-provider add "My Proxy" https://example.com/v1 --key-clipboard
`

function makeIO() {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY)
  return {
    interactive,
    out: (s) => console.log(s),
    warn: (s) => console.error(`warning: ${s}`),
    ask(q, { hidden = false } = {}) {
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
        if (hidden) {
          rl._writeToOutput = (s) => {
            if (s.includes(q)) process.stdout.write(s)
          }
        }
        rl.question(q, (ans) => {
          if (hidden) process.stdout.write("\n")
          rl.close()
          resolve(ans.trim())
        })
      })
    },
  }
}

async function wizard(P, io) {
  io.out("Add a custom OpenAI-compatible provider\n")
  const name = await io.ask("Name: ")
  const url = await io.ask("Base URL (e.g. https://api.example.com/v1): ")
  await cmdAdd(P, [], { name, url }, io)
}

export async function main(argv, deps = {}) {
  const P = paths(deps.env || process.env)
  const io = deps.io || makeIO()
  try {
    if (argv[0] === "launch") return await cmdLaunch(P, argv.slice(1), io)
    const { args, flags } = parseArgs(argv)
    const cmd = args.shift()
    if (!cmd) {
      if (io.interactive) return await wizard(P, io)
      io.out(HELP)
      return cmdList(P, io)
    }
    if (flags.help || cmd === "help" || cmd === "--help") return io.out(HELP)
    switch (cmd) {
      case "add": return await cmdAdd(P, args, flags, io, deps)
      case "list": case "ls": return cmdList(P, io)
      case "models": case "fetch": case "refresh": return await cmdModels(P, args, flags, io, deps)
      case "set": case "edit": return await cmdSet(P, args, flags, io, deps)
      case "remove": case "rm": case "delete": return cmdRemove(P, args, flags, io)
      case "relay": return await cmdRelay(P, args, flags, io, deps)
      case "diagnose": return await cmdDiagnose(P, args, flags, io, deps)
      case "doctor": return await cmdDoctor(P, args, flags, io, deps)
      case "pause": return cmdPause(P, io)
      case "resume": return cmdResume(P, io)
      case "install-command": return cmdInstallCommand(P, io)
      case "uninstall-command": return cmdUninstallCommand(P, io)
      default: fail(`Unknown command "${cmd}".\n\n${HELP}`)
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.out(`error: ${e.message}`)
      return (process.exitCode = 1)
    }
    throw e
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("custom-provider.mjs")) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`fatal: ${e?.message || e}`)
    process.exit(2)
  })
}
