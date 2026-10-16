#!/data/data/com.termux/files/usr/bin/bash
# install.sh — OpenCode for Termux/Android + /custom-provider add-on.
#
#   curl -fsSL https://raw.githubusercontent.com/freejam099-alt/Opencode-Android-/main/install.sh | bash
#
# Steps: (1) install nodejs if neither node nor bun exists,
#        (2) install OpenCode itself if missing (.deb from the Hope2333 GitHub release, sha256-verified),
#        (3) install `opencode-custom-provider` + the /custom-provider slash command.
# Flags / env: --uninstall | --upgrade-core | OPENCODE_ANDROID_SKIP_CORE=1 | OPENCODE_CORE_DEB=<file.deb> | OPENCODE_CORE_VERSION=<x.y.z> | OPENCODE_ANDROID_REF=<branch> | PREFIX=<dir>
set -euo pipefail

REPO="${OPENCODE_ANDROID_REPO:-freejam099-alt/Opencode-Android-}"
REF="${OPENCODE_ANDROID_REF:-main}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
RAW="https://raw.githubusercontent.com/$REPO/$REF"
LIB="$PREFIX/lib/opencode-custom-provider"
BIN="$PREFIX/bin/opencode-custom-provider"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

UPGRADE_CORE="${OPENCODE_CORE_FORCE:-0}"
UNINSTALL=0
for arg in "$@"; do
	case "$arg" in
	--uninstall) UNINSTALL=1 ;;
	--upgrade-core) UPGRADE_CORE=1 ;;
	esac
done

if [[ "$UNINSTALL" == "1" ]]; then
	[[ -f "$BIN" ]] && { bash "$BIN" relay none || true; bash "$BIN" uninstall-command || true; }
	for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
		[[ -f "$rc" ]] && sed -i '/# >>> opencode-custom-provider >>>/,/# <<< opencode-custom-provider <<</d' "$rc"
	done
	rm -rf "$LIB" "$BIN"
	log "removed opencode-custom-provider (your providers/config are kept)"
	exit 0
fi

# 1) JS runtime (needed by the provider manager and to read the release list)
if ! command -v node >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
	command -v pkg >/dev/null 2>&1 || die "need node or bun (pkg install nodejs)"
	log "installing nodejs"
	pkg install -y nodejs
fi

# 2) OpenCode core (skipped if `opencode` already exists).
# The Hope2333 apt/pacman repo does not always carry the package, so download the .deb straight
# from the project's GitHub release (v2 mainline, native bionic) and verify it against SHA256SUMS.txt.
CORE_REPO="${OPENCODE_CORE_REPO:-Hope2333/opencode-termux}"
CORE_PIN_TAG="Push261013" # known-good fallback if the GitHub API is unreachable / rate limited
CORE_PIN_VER="2.0.27"

core_fail() {
	cat >&2 <<'MSG'

error: could not install the OpenCode core package.
Install it manually, then run this script again (it skips the core when `opencode` already exists):
  1) open https://github.com/Hope2333/opencode-termux/releases
  2) download opencode_<version>_aarch64.deb (v2 mainline)
  3) dpkg -i ~/storage/downloads/opencode_<version>_aarch64.deb
or: OPENCODE_CORE_DEB=/path/to/opencode_<version>_aarch64.deb bash install.sh
MSG
	exit 1
}

# prints "<tag> <version>" of the newest v2 `opencode_X_aarch64.deb` release asset
discover_core() {
	local want="${OPENCODE_CORE_VERSION:-}"
	local js='
const [repo, want] = process.argv.slice(1);
const ver = (v) => v.split(".").map(Number);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { accept: "application/vnd.github+json", "user-agent": "opencode-android-installer" }, signal: AbortSignal.timeout(15000) })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((rels) => {
    let best = null;
    for (const rel of rels) for (const a of rel.assets || []) {
      const m = /^opencode_(\d+\.\d+\.\d+)_aarch64\.deb$/.exec(a.name);
      if (!m || (want && m[1] !== want)) continue;
      if (!best || cmp(ver(m[1]), ver(best.v)) > 0) best = { v: m[1], tag: rel.tag_name };
    }
    if (!best) throw new Error("no matching asset");
    console.log(best.tag + " " + best.v);
  })
  .catch((e) => { console.error(e.message); process.exit(1); });'
	local rt=node
	command -v node >/dev/null 2>&1 || rt=bun
	"$rt" -e "$js" "$CORE_REPO" "$want" 2>/dev/null
}

installed_core_version() {
	command -v opencode >/dev/null 2>&1 || return 0
	opencode --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
}

install_core() {
	local deb="${OPENCODE_CORE_DEB:-}"
	if [[ -z "$deb" ]]; then
		local arch="${OPENCODE_ARCH:-$(uname -m)}"
		[[ "$arch" == "aarch64" || "$arch" == "arm64" ]] || die "unsupported CPU '$arch': the prebuilt OpenCode packages are aarch64 only"
		local tag ver found installed
		installed="$(installed_core_version)"
		if found="$(discover_core)" && [[ -n "$found" ]]; then
			tag="${found%% *}"
			ver="${found##* }"
		elif [[ -z "${OPENCODE_CORE_VERSION:-}" || "${OPENCODE_CORE_VERSION}" == "$CORE_PIN_VER" ]]; then
			log "GitHub API unavailable, using pinned release $CORE_PIN_TAG"
			tag="$CORE_PIN_TAG"
			ver="$CORE_PIN_VER"
		else
			core_fail
		fi
		if [[ -n "$installed" && "$installed" == "$ver" ]]; then
			log "OpenCode $installed is already the newest available build ($tag)"
			return 0
		fi
		[[ -n "$installed" ]] && log "OpenCode $installed -> $ver"
		local base="https://github.com/$CORE_REPO/releases/download/$tag"
		local name="opencode_${ver}_aarch64.deb"
		local dl
		dl="$(mktemp -d)"
		log "downloading $name ($tag)"
		curl -fL# --retry 3 --retry-delay 2 -o "$dl/$name" "$base/$name" || core_fail
		if curl -fsSL --retry 2 -o "$dl/SHA256SUMS.txt" "$base/SHA256SUMS.txt" 2>/dev/null && grep -q " $name\$" "$dl/SHA256SUMS.txt"; then
			(cd "$dl" && grep " $name\$" SHA256SUMS.txt | sha256sum -c - >/dev/null) || die "checksum mismatch for $name; refusing to install"
			log "checksum OK"
		else
			log "warning: no checksum list found for $name; skipping verification"
		fi
		deb="$dl/$name"
	fi
	[[ -f "$deb" ]] || core_fail
	log "installing $(basename "$deb")"
	if ! dpkg -i "$deb"; then
		command -v pkg >/dev/null 2>&1 && pkg install -y bash ncurses && dpkg -i "$deb" || core_fail
	fi
	[[ -n "${dl:-}" ]] && rm -rf "$dl"
	return 0
}

if [[ "${OPENCODE_ANDROID_SKIP_CORE:-0}" != "1" ]]; then
	cur="$(installed_core_version)"
	if ! command -v opencode >/dev/null 2>&1; then
		install_core
	elif [[ "$UPGRADE_CORE" == "1" || ( -n "${OPENCODE_CORE_VERSION:-}" && "${OPENCODE_CORE_VERSION}" != "$cur" ) ]]; then
		install_core
	else
		log "OpenCode ${cur:-?} already installed (update/change it with: --upgrade-core or OPENCODE_CORE_VERSION=x.y.z)"
	fi
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
bash "$BIN" fix || true # enables the relay for every provider (fixes "received content after the finish reason"), repairs allow-lists

# `opencode` -> starts the local relay first (idempotent), then runs the real opencode
RC_BEGIN="# >>> opencode-custom-provider >>>"
RC_END="# <<< opencode-custom-provider <<<"
if [[ "${OPENCODE_ANDROID_NO_ALIAS:-0}" != "1" ]]; then
	for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
		[[ "$rc" == "$HOME/.zshrc" && ! -f "$rc" ]] && continue
		touch "$rc"
		grep -qF "$RC_BEGIN" "$rc" || printf '\n%s\nalias opencode='"'"'opencode-custom-provider launch'"'"'\n%s\n' "$RC_BEGIN" "$RC_END" >>"$rc"
	done
fi
log "done. Restart OpenCode, then: /custom-provider add \"My Proxy\" https://api.example.com/v1 --key-clipboard"
log "or in the shell: opencode-custom-provider"
