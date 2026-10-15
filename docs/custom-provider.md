# Custom Provider (`/custom-provider`)

Add any OpenAI-compatible endpoint (OpenRouter, a self-hosted proxy, Ollama, LM Studio, ...) to
OpenCode on Termux, with API key, display name, base URL and automatic model fetching.
**OpenCode Zen (provider id `opencode`) and every other entry in your config are never modified.**

## Install (Termux, one line)

```bash
curl -fsSL https://raw.githubusercontent.com/freejam099-alt/Opencode-Android-/main/install.sh | bash
```

Installs `nodejs` if no JS runtime is present, then OpenCode if missing (the v2 `.deb` is downloaded from the
Hope2333 GitHub release and checked against `SHA256SUMS.txt`; the apt/pacman repo is not required), then the add-on and the
slash command. Env: `OPENCODE_CORE_VERSION=x.y.z`, `OPENCODE_CORE_DEB=/path/file.deb`, `OPENCODE_ANDROID_SKIP_CORE=1`.
Uninstall: `curl -fsSL .../install.sh | bash -s -- --uninstall`.

Tool calling: new models are written with `tool_call: true` (pass `--no-tools` to omit); OpenCode's
built-in tools (read/edit/bash/...) work through `@ai-sdk/openai-compatible` as long as the model/server supports function calling.

## Manual install

Shipped in the package as `opencode-custom-provider` (needs `node` or `bun`). From a source checkout:

```bash
install -Dm755 tools/custom-provider/custom-provider.mjs "$PREFIX/lib/opencode-custom-provider/custom-provider.mjs"
install -Dm755 bin/opencode-custom-provider "$PREFIX/bin/opencode-custom-provider"
opencode-custom-provider install-command   # adds the /custom-provider slash command, then restart OpenCode
```

## Use

```bash
opencode-custom-provider                      # interactive wizard (hidden key prompt)
opencode-custom-provider add "My Proxy" https://api.example.com/v1 --key-env MY_KEY
opencode-custom-provider models --all         # re-fetch model lists (parallel); --list, --dry-run, --filter, --max
opencode-custom-provider set my-proxy --name "Proxy 2" --base-url https://other/v1
opencode-custom-provider list
opencode-custom-provider remove my-proxy
```

Inside OpenCode the same arguments work: `/custom-provider add "My Proxy" https://api.example.com/v1 --key-clipboard`.
Restart OpenCode afterwards; select models as `my-proxy/<model>` (or `/models`).

Key sources: `--key-env VAR`, `--key-file PATH`, `--key-clipboard` (Termux:API), the wizard, or
`--key VALUE`. **Avoid `--key` inside OpenCode**: slash-command arguments are saved in the session
and sent to the active model. `--no-key` for local servers.

## Provider or models do not show up

```bash
opencode-custom-provider doctor            # per-provider checklist (add --offline to skip the network test)
opencode-custom-provider doctor --fix      # repairs what is safe to repair
```

OpenCode 2.x compiles `enabled_providers` into "deny every provider except these" (and `disabled_providers` into
explicit denies), so a provider missing from such a list is silently hidden even though its models are in the config.
`add`/`set` now keep our ids allowed; `doctor` finds whitelists in the global config and in project configs
(`opencode.json(c)` and `.opencode/` from the current directory upwards), a missing key file (the config would
fail to load), a dead relay, and an unreachable server. If a server has no usable `/models`, the provider is still
added: `set <id> --models a,b` adds models by hand.

## Built-in models (Zen) cannot call tools?

This add-on never writes the `opencode` (Zen) provider; every write is checked against that invariant, and the
generated config was decoded and migrated with upstream's own v1->v2 config code in testing. To prove it on your device:

```bash
opencode-custom-provider pause     # takes all custom providers out of the config; restart OpenCode and test Zen
opencode-custom-provider resume    # puts them back
```

If Zen still fails while paused, the cause is the OpenCode core build, not this add-on. Switch core versions with
`install.sh`: `OPENCODE_CORE_VERSION=2.0.23` (any release that has an `opencode_X_aarch64.deb`), or `--upgrade-core`
for the newest build published by Hope2333 (currently 2.0.27, while upstream is at 2.0.29; 2.0.29 adds recovery for
truncated tool calls, which may matter for providers with a small output limit).

## Error: "OpenAI Chat received content after the finish reason"

OpenCode 2.x is strict: if a server sends any content after a chunk that carries `finish_reason`, the reply is
cut off with this error (seen with some Kimi/Moonshot proxies). Check your provider:

```bash
opencode-custom-provider diagnose my-proxy            # sends one tiny streaming request and inspects chunk order
opencode-custom-provider set my-proxy --relay on      # if it reports PROBLEM
opencode-custom-provider launch                       # starts the local relay, then runs opencode
```

The relay listens on `127.0.0.1` only, forwards everything unchanged and just moves `finish_reason` to the end of
the stream. It never reads your API key (OpenCode sends the Authorization header itself); `models`/`diagnose`
always talk to the real server. Handy alias: `alias oc='opencode-custom-provider launch'`.
`relay status|start|stop` manage it; `set my-proxy --relay off` removes it. If you start `opencode` directly while
the relay is on and it is not running, you get "connection refused" -- run `relay start` or use `launch`.

## Think effort (reasoning)

Think effort differs per model, so it follows what the **provider** reports in `/models` when available:
`reasoning`/`supports_reasoning`/`capabilities.reasoning`, OpenRouter-style `supported_parameters` (`reasoning`,
`reasoning_effort`), and effort lists (`reasoning_efforts`, ...) which become per-model `variants`
(`{ "low": { "reasoningEffort": "low" } }`). A provider that explicitly says `reasoning: false` gets no effort
variants. Context/output limits are filled in when the provider reports them. If the provider says nothing,
the model-id guess below applies.

Models are written with `reasoning: true` when the id looks like a reasoning model (o1/o3/o4, gpt-5, gpt-oss,
deepseek-r1/reasoner/v3/v4, qwq, qwen3, *-thinking, glm-4.5+, kimi-k2, grok-3/4, claude opus/sonnet, gemini 2.5/3, ...).
Override: `--reasoning` (all models) or `--no-reasoning` (none) on `add`/`models`. Refreshing only fills in missing
keys; a `reasoning` value you set by hand is never overwritten. In OpenCode, switch effort with the variant
key (low / medium / high); it is sent to the server as `reasoning_effort`.

Caveats: the server must understand `reasoning_effort` (OpenAI, OpenRouter, Groq, ... do; some proxies ignore it
and a few reject unknown params -- then pick the default variant or use `--no-reasoning`). Whether the thinking text
is shown depends on the server returning it. Effort variants are generated by OpenCode itself and were verified
against upstream source (v2 `variant.ts`: `@ai-sdk/openai-compatible` -> `reasoningEffort`), not on a live device.

## What it writes

- `~/.config/opencode/opencode.json` (or existing `opencode.jsonc`): only `provider.<id>` with
  `npm: @ai-sdk/openai-compatible`, `name`, `options.baseURL`, `options.apiKey = {file:...}`, `models`.
  The first rewrite saves `opencode.json.bak-custom-provider`; comments in JSONC are dropped on rewrite.
- `~/.config/opencode/custom-providers/<id>.key` (mode 0600), `<id>.models.json` (cache), `registry.json`.
- Safety: reserved ids (`opencode`, `anthropic`, `openai`, ...) and entries you wrote by hand are refused;
  an invariant check aborts if anything outside the managed ids would change.

## Fetching models

`GET <baseURL>/models` (Bearer key), 15 s timeout (`--timeout SEC`), accepts `{data:[...]}`, `{models:[...]}` or a
plain array. If the URL 404s and has no `/vN` suffix, `/v1` is tried and the base URL corrected.
Model ids with unusual characters are dropped (they are echoed into prompts by the slash command).
User-tweaked model entries (e.g. custom `limit`) survive refreshes.

## Performance notes

- Nothing touches the network at OpenCode startup; models are a static map written on demand.
- Model maps are capped at 200 (`--max`, `--filter`): large maps slow config parsing and the model picker.
- Refreshing several providers runs in parallel.
- Startup cost of the OpenCode runtime itself (183 MB wrapper heap read) is in the external
  `wrapper.c`, not this repo; see `docs/performance-optimization.md` §7.1.

## Tests

`node --test tests/unit/custom-provider.test.mjs` (also run by `make test`).
