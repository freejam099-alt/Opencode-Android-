# Custom Provider (`/custom-provider`)

Add any OpenAI-compatible endpoint (OpenRouter, a self-hosted proxy, Ollama, LM Studio, ...) to
OpenCode on Termux, with API key, display name, base URL and automatic model fetching.
**OpenCode Zen (provider id `opencode`) and every other entry in your config are never modified.**

## Install (Termux, one line)

```bash
curl -fsSL https://raw.githubusercontent.com/freejam099-alt/Opencode-Android-/main/install.sh | bash
```

Installs OpenCode if missing, `nodejs` if no JS runtime is present, then the add-on and the slash command.
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
