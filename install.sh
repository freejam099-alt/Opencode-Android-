#!/data/data/com.termux/files/usr/bin/bash
# install.sh — OpenCode for Termux/Android + /custom-provider add-on.
#
#   curl -fsSL https://raw.githubusercontent.com/freejam099-alt/Opencode-Android-/main/install.sh | bash
#
# Steps: (1) install OpenCode itself if missing (Hope2333 Termux package repo installer),
#        (2) install nodejs if neither node nor bun exists,
#        (3) install `opencode-custom-provider` + the /custom-provider slash command.
# Flags / env: --uninstall | OPENCODE_ANDROID_SKIP_CORE=1 | OPENCODE_ANDROID_REF=<branch> | PREFIX=<dir>
set -euo pipefail

REPO="${OPENCODE_ANDROID_REPO:-freejam099-alt/Opencode-Android-}"
REF="${OPENCODE_ANDROID_REF:-main}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
RAW="https://raw.githubusercontent.com/$REPO/$REF"
LIB="$PREFIX/lib/opencode-custom-provider"
BIN="$PREFIX/bin/opencode-custom-provider"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
	[[ -f "$BIN" ]] && bash "$BIN" uninstall-command || true
	rm -rf "$LIB" "$BIN"
	log "removed opencode-custom-provider (your providers/config are kept)"
	exit 0
fi

# 1) OpenCode core (skipped if already installed). Termux build comes from the Hope2333 package repo.
CORE_URL="${OPENCODE_CORE_INSTALLER:-https://hope2333.github.io/repo/install.sh}"
if [[ "${OPENCODE_ANDROID_SKIP_CORE:-0}" != "1" ]] && ! command -v opencode >/dev/null 2>&1; then
	log "installing OpenCode core via $CORE_URL"
	if ! curl -fsSL "$CORE_URL" | sh -s -- --install opencode; then
		cat >&2 <<'MSG'

error: could not install the OpenCode core package.
Install it manually, then run this script again (it skips the core when `opencode` already exists):
  1) open https://github.com/Hope2333/opencode-termux/releases
  2) download opencode_<version>_aarch64.deb (v2 mainline)
  3) dpkg -i ~/storage/downloads/opencode_<version>_aarch64.deb
MSG
		exit 1
	fi
fi

# 2) JS runtime for the provider manager
if ! command -v node >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
	command -v pkg >/dev/null 2>&1 || die "need node or bun (pkg install nodejs)"
	log "installing nodejs"
	pkg install -y nodejs
fi

# 3) add-on files: local checkout if available, else download
SRC_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
	cand="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	[[ -f "$cand/tools/custom-provider/custom-provider.mjs" ]] && SRC_DIR="$cand"
fi
mkdir -p "$LIB" "$PREFIX/bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if [[ -n "$SRC_DIR" ]]; then
	cp "$SRC_DIR/tools/custom-provider/custom-provider.mjs" "$tmp/custom-provider.mjs"
	cp "$SRC_DIR/bin/opencode-custom-provider" "$tmp/opencode-custom-provider"
else
	log "downloading from $REPO@$REF"
	curl -fsSL "$RAW/tools/custom-provider/custom-provider.mjs" -o "$tmp/custom-provider.mjs"
	curl -fsSL "$RAW/bin/opencode-custom-provider" -o "$tmp/opencode-custom-provider"
fi
install -m 755 "$tmp/custom-provider.mjs" "$LIB/custom-provider.mjs"
install -m 755 "$tmp/opencode-custom-provider" "$BIN"

bash "$BIN" install-command
log "done. Restart OpenCode, then: /custom-provider add \"My Proxy\" https://api.example.com/v1 --key-clipboard"
log "or in the shell: opencode-custom-provider"
