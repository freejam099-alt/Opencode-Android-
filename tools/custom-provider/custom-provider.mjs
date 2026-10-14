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
import { execFileSync } from "node:child_process"

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
const DEFAULT_MAX_MODELS = 200
const DEFAULT_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MODEL_ID_RE = /^[\w.:@+/-]{1,128}$/

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
  }
}

// --------------------------------------------------------------------------
// small utils
// --------------------------------------------------------------------------
export class CliError extends Error {}
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
    delete c.$schema
    return c
  }
  if (!deepEqual(strip(before), strip(after))) fail("Internal safety check failed: unrelated config would change. Nothing was written.")
  if (after.provider?.opencode && !deepEqual(before.provider?.opencode, after.provider.opencode)) fail("Internal safety check failed: OpenCode Zen entry would change.")
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
export function extractModelIds(body) {
  let list = []
  if (Array.isArray(body)) list = body
  else if (body && Array.isArray(body.data)) list = body.data
  else if (body && Array.isArray(body.models)) list = body.models
  const ids = []
  for (const m of list) {
    const id = typeof m === "string" ? m : (m?.id ?? m?.name ?? m?.model)
    if (typeof id === "string") ids.push(id)
  }
  return ids
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

// Returns { baseURL, ids } -- baseURL may be corrected (adds /v1 if that is what works).
export async function fetchModels(baseURL, key, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const candidates = [baseURL]
  if (!/\/v\d+$/.test(baseURL)) candidates.push(`${baseURL}/v1`)
  let lastStatus = 0
  for (const base of candidates) {
    const r = await fetchJson(`${base}/models`, key, headers, timeoutMs, fetchImpl)
    lastStatus = r.status
    if (r.body) {
      const ids = extractModelIds(r.body)
      if (ids.length) return { baseURL: base, ids }
      continue
    }
    if (r.status === 401 || r.status === 403) fail(`Authentication failed (HTTP ${r.status}). Check the API key.`)
    if (r.status === 429) fail("Rate limited (HTTP 429). Try again shortly.")
  }
  fail(
    `Could not fetch models from ${baseURL}/models (last status ${lastStatus || "n/a"}).\n` +
      `The server may not expose a model list; add models manually with: --models id1,id2`,
  )
}

// --------------------------------------------------------------------------
// provider ops
// --------------------------------------------------------------------------
// New models get `tool_call: true` (agentic tool use: read/edit/bash/...) unless --no-tools.
function buildModelsMap(existing, ids, { tools = true } = {}) {
  const fresh = (id) => ({ name: id, ...(tools ? { tool_call: true } : {}) })
  const map = {}
  for (const id of ids) map[id] = existing?.[id] && typeof existing[id] === "object" ? existing[id] : fresh(id)
  // keep user-customised entries (anything beyond name/tool_call) even if the server dropped them
  for (const [id, v] of Object.entries(existing || {})) if (!(id in map) && v && Object.keys(v).some((k) => k !== "name" && k !== "tool_call")) map[id] = v
  return map
}

function parseHeaders(list) {
  const out = {}
  for (const h of [].concat(list || [])) {
    const i = String(h).indexOf("=")
    if (i < 1) fail(`Invalid --header "${h}" (use Name=Value)`)
    out[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim()
  }
  return out
}

function describe(id, entry, P) {
  const n = Object.keys(entry.models || {}).length
  const key = readKey(P, id)
  return `${id}  "${entry.name}"  ${entry.options?.baseURL}  models=${n}  key=${maskKey(key)}`
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

  let baseURL = normalizeBaseURL(url)
  let keyInfo = resolveKeyFromFlags(flags, deps.env)
  if (keyInfo.key === undefined && !keyInfo.none && io.interactive) {
    keyInfo = { key: await io.ask("API key (hidden, empty for none): ", { hidden: true }) }
  }
  const key = keyInfo.key || ""
  const headers = parseHeaders(flags.header)
  if (keyInfo.viaArgv) io.warn("Key was passed on the command line. Inside OpenCode that lands in your session history and is sent to the model provider. Prefer --key-env, --key-file, --key-clipboard or the interactive wizard.")

  let ids = []
  let info = ""
  if (flags.models) {
    ids = String(flags.models).split(",").map((s) => s.trim()).filter(Boolean)
  } else if (!flags["no-fetch"]) {
    const r = await fetchModels(baseURL, key, { headers, timeoutMs: Number(flags.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000, fetchImpl: deps.fetchImpl })
    if (r.baseURL !== baseURL) info += `base URL corrected to ${r.baseURL}\n`
    baseURL = r.baseURL
    const sel = selectModels(r.ids, { filter: flags.filter, max: flags.max ? Number(flags.max) : DEFAULT_MAX_MODELS })
    ids = sel.ids
    info += modelSummary(sel)
    fs.mkdirSync(P.dataDir, { recursive: true })
    atomicWrite(P.modelsCache(id), JSON.stringify({ fetchedAt: new Date().toISOString(), ids: r.ids.filter((x) => MODEL_ID_RE.test(x)) }) + "\n")
  }

  if (key) writeKey(P, id, key)
  else if (fs.existsSync(P.keyFile(id))) fs.rmSync(P.keyFile(id))

  const entry = {
    npm: NPM_PKG,
    name,
    options: {
      baseURL,
      ...(key ? { apiKey: `{file:${tildePath(P, P.keyFile(id))}}` } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    },
    models: buildModelsMap({}, ids, { tools: !flags["no-tools"] }),
  }
  saveConfig(P, loaded, (cfg) => {
    cfg.provider = cfg.provider || {}
    cfg.provider[id] = entry
  }, [id])
  reg.providers[id] = { name, createdAt: new Date().toISOString() }
  saveRegistry(P, reg)

  io.out(`${info}Added provider "${name}" (id: ${id}) with ${ids.length} model(s).`)
  if (!ids.length) io.out(`No models yet. Run: models ${id}   (or add with --models a,b)`)
  io.out(`Use it in OpenCode as ${id}/<model>. Restart OpenCode to load it. OpenCode Zen is untouched.`)
}

function modelSummary(sel) {
  let s = `Fetched ${sel.total} model(s)`
  if (sel.skipped) s += `, skipped ${sel.skipped} with unsafe ids`
  s += ".\n"
  if (sel.truncated) s += `Kept the first ${sel.ids.length}. Use --filter <regex> (or --max N) to choose which; very large model maps slow down startup.\n`
  return s
}

export async function cmdModels(P, args, flags, io, deps = {}) {
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const wanted = flags.all || !args.length ? Object.keys(reg.providers) : args.map((a) => slugify(a))
  if (!wanted.length) fail("No custom providers yet. Add one with: add <name> <baseURL>")
  for (const id of wanted) if (!reg.providers[id] || !loaded.cfg.provider?.[id]) fail(`Unknown custom provider "${id}". Run "list".`)

  // fetch in parallel; apply sequentially
  const results = await Promise.allSettled(
    wanted.map(async (id) => {
      const entry = loaded.cfg.provider[id]
      const r = await fetchModels(entry.options.baseURL, readKey(P, id), {
        headers: entry.options.headers || {},
        timeoutMs: Number(flags.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000,
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
  save(P, loaded, (cfg) => {
    for (const { id, r } of updates) {
      const entry = cfg.provider[id]
      const sel = selectModels(r.ids, { filter: flags.filter, max: flags.max ? Number(flags.max) : DEFAULT_MAX_MODELS })
      const before = Object.keys(entry.models || {})
      if (!flags["dry-run"]) {
        entry.options.baseURL = r.baseURL
        entry.models = buildModelsMap(entry.models, sel.ids, { tools: !flags["no-tools"] })
        fs.mkdirSync(P.dataDir, { recursive: true })
        atomicWrite(P.modelsCache(id), JSON.stringify({ fetchedAt: new Date().toISOString(), ids: r.ids.filter((x) => MODEL_ID_RE.test(x)) }) + "\n")
      }
      const after = Object.keys(flags["dry-run"] ? Object.fromEntries(sel.ids.map((x) => [x, 1])) : entry.models)
      const added = after.filter((x) => !before.includes(x)).length
      const removed = before.filter((x) => !after.includes(x)).length
      lines.push(`${id}: ${after.length} model(s) (+${added} / -${removed})${sel.truncated ? " [truncated; use --filter]" : ""}${sel.skipped ? ` [${sel.skipped} unsafe ids skipped]` : ""}`)
      if (flags.list || flags["dry-run"]) lines.push(...sel.ids.map((x) => `  - ${x}`))
    }
  }, updates.map((u) => u.id))
  io.out(lines.join("\n") + (flags["dry-run"] ? "\n(dry run: nothing written)" : "\nRestart OpenCode to reload models."))
}

export function cmdList(P, io) {
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  const ids = Object.keys(reg.providers).filter((id) => loaded.cfg.provider?.[id])
  if (!ids.length) return io.out("No custom providers. Add one: add <name> <baseURL> [--key-env VAR]")
  io.out(ids.map((id) => describe(id, loaded.cfg.provider[id], P)).join("\n"))
}

export async function cmdSet(P, args, flags, io, deps = {}) {
  const id = slugify(args[0] || "")
  const reg = loadRegistry(P)
  const loaded = loadConfig(P)
  if (!id || !reg.providers[id] || !loaded.cfg.provider?.[id]) fail(`Unknown custom provider "${args[0] || ""}". Run "list".`)
  const keyInfo = resolveKeyFromFlags(flags, deps.env)
  if (keyInfo.viaArgv) io.warn("Key was passed on the command line (it ends up in shell/session history). Prefer --key-env / --key-file / --key-clipboard.")
  let newKey = keyInfo.key
  if (newKey === undefined && !keyInfo.none && !flags.name && !flags["base-url"] && !flags.header && io.interactive) newKey = await io.ask("New API key (hidden, empty to keep): ", { hidden: true })
  const headers = flags.header ? parseHeaders(flags.header) : null
  saveConfig(P, loaded, (cfg) => {
    const e = cfg.provider[id]
    if (flags.name) e.name = String(flags.name)
    if (flags["base-url"]) e.options.baseURL = normalizeBaseURL(flags["base-url"])
    if (headers) e.options.headers = { ...(e.options.headers || {}), ...headers }
    if (keyInfo.none) {
      delete e.options.apiKey
      if (fs.existsSync(P.keyFile(id))) fs.rmSync(P.keyFile(id))
    } else if (newKey) {
      writeKey(P, id, newKey)
      e.options.apiKey = `{file:${tildePath(P, P.keyFile(id))}}`
    }
  }, [id])
  if (flags.name) {
    reg.providers[id].name = String(flags.name)
    saveRegistry(P, reg)
  }
  io.out(`Updated "${id}". ` + (flags["base-url"] ? "Run: models " + id + "  to refresh the model list. " : "") + "Restart OpenCode to apply.")
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
  }, [id])
  for (const f of [P.keyFile(id), P.modelsCache(id)]) if (fs.existsSync(f)) fs.rmSync(f)
  delete reg.providers[id]
  saveRegistry(P, reg)
  io.out(`Removed "${id}" (config entry, key file, model cache). OpenCode Zen and other providers are untouched.`)
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
  const BOOL = new Set(["no-key", "no-fetch", "key-clipboard", "all", "list", "dry-run", "force", "help", "no-tools"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      const k = a.slice(2, eq < 0 ? undefined : eq)
      let v = eq < 0 ? undefined : a.slice(eq + 1)
      if (BOOL.has(k)) v = v === undefined ? true : v !== "false"
      else if (v === undefined) v = argv[++i]
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
  set <id> [options]               change --name / --base-url / key / --header
  remove <id>                      delete provider, key file and model cache
  install-command | uninstall-command
                                   add/remove the /custom-provider slash command

key options:  --key-env VAR | --key-file PATH | --key-clipboard | --no-key | --key VALUE (not recommended)
other:        --no-tools (models without tool calling)  --id ID  --models a,b,c  --no-fetch  --filter REGEX  --max N  --timeout SEC  --header Name=Value

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
  const { args, flags } = parseArgs(argv)
  const cmd = args.shift()
  try {
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
