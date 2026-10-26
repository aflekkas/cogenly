#!/bin/sh
# Installs the Cogenly server and CLI on Linux from a GitHub Release archive
# of aflekkas/cogenly. Needs only sh, tar, sha256sum or shasum, and curl or
# wget; no Node, npm, or compiler. On a Mac, the desktop app runs the server.
#
#   curl -fsSL https://raw.githubusercontent.com/aflekkas/cogenly/main/scripts/install.sh | sh
#
# Environment:
#   COGENLY_CHANNEL           release train to follow: prod or staging (default: prod)
#   COGENLY_VERSION           exact version to install (overrides COGENLY_CHANNEL)
#   COGENLY_HOME              Cogenly home directory (default: ~/.cogenly)
#   COGENLY_INSTALL_BIN_DIR   where the `cogenly` symlink goes (default: ~/.local/bin)
#   COGENLY_RELEASE_BASE_URL  mirror for releases/download (default: GitHub Releases)
#
# The archive is unpacked into $COGENLY_HOME/runtime/versions/<version>, the
# same layout `cogenly service install` and desktop SSH use, so neither
# downloads the release again.
set -eu

repo="aflekkas/cogenly"
base_url="${COGENLY_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
base_url="${base_url%/}"
t3_home="${COGENLY_HOME:-$HOME/.cogenly}"
bin_dir="${COGENLY_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\ncogenly install: %s\n' "$1" >&2
  exit 1
}

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       Cogenly' >&2
  printf '  %s%s     %sCLI installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) fail "on a Mac, install the Cogenly desktop app: https://github.com/${repo}/releases/latest" ;;
  *) fail "unsupported operating system $(uname -s); Cogenly releases ship Linux servers" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${COGENLY_CHANNEL:-prod}"
version="${COGENLY_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are v<semver>. Prod tags are plain X.Y.Z; staging tags carry a
  # -staging.<date>.<run> prerelease, so a prod install never picks one up.
  case "$channel" in
    prod | stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    staging) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-staging\.[0-9]*\.[0-9]*\)' ;;
    *) fail "COGENLY_CHANNEL must be prod or staging" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index" \
    || fail "could not list Cogenly releases; set COGENLY_VERSION"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set COGENLY_VERSION"
fi


versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

# The executable is `cogenly`, or `t3` in a release from before the rename.
# Drop the t3 fallbacks only as "Transition: t3 → cogenly names" in
# docs/operations/release.md describes.
runtime_entry() {
  if [ -e "$1/cogenly" ] || [ ! -e "$1/t3" ]; then printf '%s/cogenly\n' "$1"
  else printf '%s/t3\n' "$1"; fi
}

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  trap '[ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }; rm -rf "$staging"' EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s Cogenly %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "Cogenly ${version} has no release archive for ${platform}-${arch}"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  # Releases from before the rename list only the t3- archive.
  archive=
  for candidate in "cogenly-${version}-${platform}-${arch}.tar.gz" "t3-${version}-${platform}-${arch}.tar.gz"; do
    expected="$(grep " \*\{0,1\}${candidate}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
    if [ -n "$expected" ]; then archive="$candidate"; break; fi
  done
  [ -n "$archive" ] || fail "Cogenly ${version} has no release archive for ${platform}-${arch}"
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting Cogenly..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "$(runtime_entry "$staging")" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  [ ! -e "$target_dir" ] || fail "an incomplete runtime already exists at ${target_dir}; inspect it before reinstalling"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

# Keep package detection, non-interactive elevation and the confinement probe in Cogenly.
# Older explicitly pinned releases may not have this command yet.
if "$(runtime_entry "$target_dir")" security setup --help 2>/dev/null | grep -q -- "--local"; then
  "$(runtime_entry "$target_dir")" security setup --local </dev/null
fi

# Existing service installs use the downloaded CLI's preflight, trial and rollback.
if [ -f "${t3_home}/runtime/service-state.json" ]; then
  PATH="${bin_dir}:$PATH" COGENLY_HOME="$t3_home" "$(runtime_entry "$target_dir")" update "$version" --yes
  exit $?
fi

step "Setting up the cogenly command..."
mkdir -p "$bin_dir"
ln -sfn "$(runtime_entry "$target_dir")" "${bin_dir}/cogenly"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled Cogenly %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %scogenly%s to get started.\n\n' "$bold" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %scogenly%s.\n\n' "$bin_dir" "$bold" "$reset" ;;
esac
