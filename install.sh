#!/bin/sh
# learningcode installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/stemtrooper/learningcode/main/install.sh | bash
#
# Why a script at all: learningcode is a Node CLI whose launcher spawns
# `process.execPath` with the Pi runtime loaded from node_modules, including a
# per-platform native module. There is no single static binary that could
# replace that, so this installer only has to guarantee two things and then get
# out of the way:
#
#   1. a Node at or above the floor in lib/config.mjs
#   2. a global npm install inside a prefix the student owns
#
# What it creates under $HOME/.learningcode (override with
# LEARNINGCODE_INSTALL_ROOT):
#
#   prefix/   npm --global prefix. No sudo: root-owned global directories break
#             the *next* upgrade with a permissions error, which is the most
#             common way a student ends up stuck.
#   node/     an official Node tarball, fetched only when the system Node is
#             missing, older than the floor, or shipped without npm
#   agent/    runtime config; created by learningcode itself, never by us
#
# Nothing here touches the system package manager, ~/.npmrc, or sudo.

set -eu

PACKAGE="${LEARNINGCODE_PACKAGE:-@stemtrooper/learningcode}"
# Optional pin, e.g. LEARNINGCODE_VERSION=0.4.11; empty means npm's default.
VERSION_TAG="${LEARNINGCODE_VERSION:-}"

# Mirrors REQUIRED_NODE in lib/config.mjs; installer.test.mjs fails the build
# if the two drift, because a floor the installer does not enforce is a floor a
# student only discovers when the CLI refuses to start.
REQUIRED_NODE="22.19.0"

# The LTS tarball fetched from nodejs.org only when the system Node is unusable.
# Pinned rather than resolving "latest": an upstream regression must not be
# able to break every student install on the same day. Bump it deliberately.
FALLBACK_NODE="24.21.0"

INSTALL_ROOT="${LEARNINGCODE_INSTALL_ROOT:-$HOME/.learningcode}"
PREFIX="$INSTALL_ROOT/prefix"
NODE_ROOT="$INSTALL_ROOT/node"
BIN="$PREFIX/bin/learningcode"

START_MARKER="# >>> learningcode >>>"
END_MARKER="# <<< learningcode <<<"

NODE_BY_US=0
INSTALLED_VERSION=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	BOLD=$(printf '\033[1m')
	CYAN=$(printf '\033[36m')
	GREEN=$(printf '\033[32m')
	YELLOW=$(printf '\033[33m')
	RED=$(printf '\033[31m')
	RESET=$(printf '\033[0m')
else
	BOLD='' CYAN='' GREEN='' YELLOW='' RED='' RESET=''
fi

say() { printf '%s==>%s %s\n' "$CYAN$BOLD" "$RESET" "$*"; }
ok() { printf '%s==>%s %s\n' "$GREEN$BOLD" "$RESET" "$*"; }
note() { printf '%s==>%s %s\n' "$YELLOW$BOLD" "$RESET" "$*"; }
warn() { printf '%s==>%s %s\n' "$YELLOW$BOLD" "$RESET" "$*" >&2; }
die() { printf '%s==>%s %s\n' "$RED$BOLD" "$RESET" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# LC_ALL=C so the comparison never depends on the student's locale. Numeric
# ordering matters here: under a plain string compare 22.9.0 sorts above
# 22.19.0, so a Node too old to run learningcode would pass as supported.
version_ge() {
	[ "$1" = "$2" ] && return 0
	[ "$(printf '%s\n%s\n' "$2" "$1" | LC_ALL=C sort -V | head -n 1)" = "$2" ]
}

node_version() { "${1:-node}" --version 2>/dev/null | sed 's/^v//' | head -n 1; }

fetch() {
	if have curl; then
		curl -fSL --retry 3 --connect-timeout 20 -o "$2" "$1"
	elif have wget; then
		wget -q --tries=3 --timeout=20 -O "$2" "$1"
	else
		die "curl or wget is required to download Node."
	fi
}

# LEARNINGCODE_ALLOW_ROOT exists for containers and CI, where $HOME is a
# throwaway directory. On a real machine, root-owned files poison the next
# upgrade, which is exactly what the README's install section warns about.
if [ "$(id -u)" = "0" ] && [ -z "${LEARNINGCODE_ALLOW_ROOT:-}" ]; then
	die "Do not run this installer as root or with sudo.

It writes only to \$HOME/.learningcode and needs no privileges."
fi

OS_NAME=$(uname -s)
OS_MACHINE=$(uname -m)

case "$OS_NAME" in
	Linux) NODE_PLATFORM='linux' ;;
	Darwin) NODE_PLATFORM='darwin' ;;
	MINGW*|MSYS*|CYGWIN*|Windows*|*_NT-*)
		die "This one-liner covers macOS and Linux. On Windows use PowerShell:

    npm install -g @stemtrooper/learningcode
    learningcode --version

Full instructions: https://github.com/stemtrooper/learningcode#install" ;;
	*) die "Unsupported operating system: $OS_NAME" ;;
esac

case "$OS_MACHINE" in
	x86_64|amd64) NODE_ARCH='x64' ;;
	aarch64|arm64) NODE_ARCH='arm64' ;;
	armv7l|armv6l|armv5tel)
		die "Official Node builds do not cover 32-bit ARM ($OS_MACHINE).

Install Node $REQUIRED_NODE or newer yourself, then:

    npm install -g @stemtrooper/learningcode" ;;
	*) die "Unsupported architecture: $OS_MACHINE" ;;
esac

# Termux is bionic-based Android: the official Linux tarballs are glibc and
# cannot run there, but pkg ships a Node that clears the floor.
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux/files/usr ]; then
	IS_TERMUX=1
else
	IS_TERMUX=0
fi

is_musl() {
	ldd --version 2>&1 | head -n 1 | grep -qi musl && return 0
	# The library name varies by architecture, so match with a glob rather than
	# shelling out to ls.
	for lib in /lib/libc.musl-*.so.1; do
		[ -e "$lib" ] && return 0
	done
	return 1
}

# WSL appends the Windows PATH to the Linux one, so a Windows node.exe answers
# `command -v node` from inside Linux. It runs, but it resolves paths as Windows
# paths and installs with Windows shims, so an install that used it only breaks
# once the student is back in a Linux terminal. Treat it as absent.
is_wsl() { uname -r | grep -qi microsoft; }

# A cross-mounted binary is not a usable runtime for this install.
linux_path_of() {
	found=$(command -v "$1" 2>/dev/null || true)
	case "$found" in
		/mnt/*|/c/*) found='' ;;
	esac
	printf '%s' "$found"
}

TARBALL="node-v${FALLBACK_NODE}-${NODE_PLATFORM}-${NODE_ARCH}.tar.gz"

fetch_node_official() {
	# The downloaded runtime goes on PATH ahead of the old system Node; without
	# that, `learningcode` would keep starting on the Node too old to run it.
	say "Downloading Node v${FALLBACK_NODE} ($NODE_PLATFORM/$NODE_ARCH) from nodejs.org"
	WORK=$(mktemp -d)
	trap 'rm -rf "$WORK"' EXIT INT TERM
	fetch "https://nodejs.org/dist/v${FALLBACK_NODE}/$TARBALL" "$WORK/node.tar.gz"
	tar -xzf "$WORK/node.tar.gz" -C "$WORK"
	rm -rf "$NODE_ROOT"
	mkdir -p "$NODE_ROOT"
	mv "$WORK/node-v${FALLBACK_NODE}-${NODE_PLATFORM}-${NODE_ARCH}"/* "$NODE_ROOT"/

	export PATH="$NODE_ROOT/bin:$PATH"
	NODE_BY_US=1
	bundled=$("$NODE_ROOT/bin/node" --version | sed 's/^v//')
	version_ge "$bundled" "$REQUIRED_NODE" ||
		die "Installed Node $bundled is below the required $REQUIRED_NODE."
	say "Node v$bundled is private to learningcode at $NODE_ROOT"
}

ensure_node() {
	system_node_path=''
	if is_wsl; then
		system_node_path=$(linux_path_of node)
	else
		command -v node >/dev/null 2>&1 && system_node_path=$(command -v node)
	fi
	system_node=''
	[ -n "$system_node_path" ] && system_node=$(node_version "$system_node_path" || true)

	npm_ok=0
	if [ -n "$system_node_path" ]; then
		if is_wsl; then
			if [ -n "$(linux_path_of npm)" ]; then npm_ok=1; fi
		else
			if have npm; then npm_ok=1; fi
		fi
	fi

	if [ -n "$system_node" ] && version_ge "$system_node" "$REQUIRED_NODE" && [ "$npm_ok" = 1 ]; then
		say "Using Node $system_node ($system_node_path) with npm"
		return
	fi

	if [ -n "$system_node" ]; then
		warn "Node $system_node is older than the required $REQUIRED_NODE, or has no npm; learningcode would not start on it."
	else
		warn "No usable Node on PATH."
		have npm && warn "npm is on PATH but Node is not; learningcode will get its own runtime."
	fi

	# A runtime fetched on a previous run is still a perfectly good Node, and
	# students on metered data should not pay for it twice.
	if [ -x "$NODE_ROOT/bin/node" ]; then
		bundled=$("$NODE_ROOT/bin/node" --version 2>/dev/null | sed 's/^v//' || true)
		if [ -n "$bundled" ] && version_ge "$bundled" "$REQUIRED_NODE"; then
			say "Reusing Node $bundled already installed at $NODE_ROOT"
			export PATH="$NODE_ROOT/bin:$PATH"
			return
		fi
		warn "Node at $NODE_ROOT is missing or too old; fetching a fresh one."
	fi

	if [ "$IS_TERMUX" = 1 ]; then
		say "Installing nodejs-lts and npm with pkg (Termux)"
		pkg install -y nodejs-lts npm
		termux_node=$(node_version "$(command -v node)" || true)
		version_ge "$termux_node" "$REQUIRED_NODE" || die "Termux installed Node '${termux_node:-none}', still below $REQUIRED_NODE."
		say "Using Node $termux_node"
		return
	fi

	# Not piped through anything: die() writes to stderr and exits, and a pipe
	# would run it in a subshell where that exit only ends the subshell.
	if is_musl; then
		die "musl-based distribution detected (Alpine?). The official Node tarballs need glibc.

Use the distribution's own Node if it clears the floor:

    apk add nodejs npm
    node --version
    npm install -g @stemtrooper/learningcode"
	fi

	fetch_node_official
}

install_cli() {
	spec="$PACKAGE"
	[ -n "$VERSION_TAG" ] && spec="$PACKAGE@$VERSION_TAG"

	say "Installing $spec into $PREFIX"
	mkdir -p "$PREFIX"
	# --prefix keeps the install inside a directory the student owns. Do not
	# reach for `sudo npm i -g`: it appears to work, then writes root-owned
	# files that break the next upgrade.
	npm install --global --prefix "$PREFIX" --no-audit --no-fund "$spec" ||
		die "npm install failed. Re-run it by hand to see the full error: npm i -g $PACKAGE"
}

# Fold $HOME back to a literal $HOME so the line stays correct if the rc file
# is ever read on another machine (a synced home directory, mostly).
rc_path() {
	case "$1" in
		"$HOME"/*) printf '$HOME%s' "${1#"$HOME"}" ;;
		*) printf '%s' "$1" ;;
	esac
}

detect_rc() {
	if [ -n "${LEARNINGCODE_RC_FILE:-}" ]; then
		printf '%s\n' "$LEARNINGCODE_RC_FILE"
		return
	fi
	case "$(basename "${SHELL:-sh}")" in
		zsh) printf '%s\n' "$HOME/.zshrc" ;;
		*)
			if [ -f "$HOME/.bashrc" ]; then
				printf '%s\n' "$HOME/.bashrc"
			elif [ -f "$HOME/.profile" ]; then
				printf '%s\n' "$HOME/.profile"
			else
				printf '%s\n' "$HOME/.bashrc"
			fi
			;;
	esac
}

ensure_path() {
	node_first=''
	if [ "$NODE_BY_US" = 1 ]; then node_first="$(rc_path "$NODE_ROOT")/bin:"; fi
	line="export PATH=\"${node_first}$(rc_path "$PREFIX")/bin:\$PATH\""

	if [ "$(basename "${SHELL:-}")" = fish ]; then
		# A POSIX export written into a fish config does nothing, so state the
		# line rather than writing something that only looks like it worked.
		fish_line="set -gx PATH"
		[ -n "$node_first" ] && fish_line="$fish_line $NODE_ROOT/bin"
		fish_line="$fish_line $PREFIX/bin \$PATH"
		warn "Fish shell users: add this line to ~/.config/fish/config.fish yourself:"
		printf '    %s\n' "$fish_line" >&2
		PATH_UPDATED=0
		return
	fi

	# Every file that can put learningcode on PATH. A bash shell is the
	# complication: interactive terminals read .bashrc, login shells read
	# .profile, and Ubuntu's .bashrc returns early for non-interactive shells.
	# So `ssh host learningcode` needs .profile while a new tab needs .bashrc,
	# and either file may not exist yet on a fresh machine.
	primary=$(detect_rc)
	targets=$primary
	if [ -z "${LEARNINGCODE_RC_FILE:-}" ] && [ "$(basename "${SHELL:-sh}")" = bash ]; then
		if [ "$primary" != "$HOME/.bashrc" ]; then
			targets="$targets $HOME/.bashrc"
		fi
		if [ -f "$HOME/.profile" ] && [ "$primary" != "$HOME/.profile" ]; then
			targets="$targets $HOME/.profile"
		fi
	fi

	PATH_UPDATED=0
	for target in $targets; do
		[ -d "$(dirname "$target")" ] || mkdir -p "$(dirname "$target")"
		if grep -Fqs "$START_MARKER" "$target" 2>/dev/null; then
			say "PATH is already set up in $target"
			continue
		fi
		printf '\n%s\n%s\n%s\n' "$START_MARKER" "$line" "$END_MARKER" >>"$target"
		PATH_UPDATED=1
		say "Added learningcode to PATH in $target"
	done
}

verify() {
	[ -e "$BIN" ] || die "npm reported success but $BIN is missing. Try installing by hand: npm i -g $PACKAGE"
	INSTALLED_VERSION=$("$BIN" --version 2>/dev/null || true)
	[ -n "$INSTALLED_VERSION" ] ||
		die "$BIN --version produced no output. Reinstall with: npm i -g $PACKAGE"
}

main() {
	printf '\n%s  learningcode\n%s' "$BOLD" "$RESET"
	printf '  The Learning Curve / Sarawak\n\n'

	ensure_node

	# Checked after the bootstrap rather than before: a Node this installer
	# fetched on an earlier run brings its own npm, so "no npm on PATH" is only
	# fatal once no working runtime can be found.
	if ! have npm; then
		die "npm is required but not on PATH. Install Node $REQUIRED_NODE or newer, then re-run this installer."
	fi

	install_cli
	ensure_path
	verify

	ok "learningcode $INSTALLED_VERSION is installed"
	printf '\n'
	printf '  Start it in a project directory:\n'
	printf '    learningcode\n\n'
	printf '  It will ask for your Spark token. Ask your teacher for one (Spark\n'
	printf '  bench - Issue / rotate token); it is shown once. Re-enter it any\n'
	printf '  time with:\n'
	printf '    learningcode --login\n\n'
	printf '  Upgrade later:\n'
	printf '    npm i -g %s\n' "$PACKAGE"
	printf '  Docs:\n'
	printf '    https://github.com/stemtrooper/learningcode#readme\n'

	if [ "${PATH_UPDATED:-0}" = 1 ]; then
		printf '\n'
		# stdout rather than stderr, so this lands where it was printed when the
		# whole run is piped into a log.
		note "Open a new terminal, or source: $targets"
	fi
	printf '\n'
}

main "$@"
