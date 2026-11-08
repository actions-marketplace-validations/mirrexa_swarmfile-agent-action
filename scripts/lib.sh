#!/usr/bin/env bash
# Shared helpers for the Swarmfile agent action.

fail() { printf '::error::%s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
need() { [ -n "${!1:-}" ] || fail "$2"; }

sanitize_label() {
  local value="${1:-agent}"
  printf '%s' "$value" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs 'a-z0-9-' '-' \
    | sed 's/^-*//;s/-*$//' \
    | cut -c1-32
}

branch_for() {
  local label="$1" prefix="${2:-agents}"
  printf '%s/%s-%s-%s' "$prefix" "$label" "${GITHUB_RUN_ID:-local}" "${GITHUB_RUN_ATTEMPT:-1}"
}

new_work_dir() {
  local base="${RUNNER_TEMP:-/tmp}"
  mkdir -p "$base"
  mktemp -d "$base/swarmfile-agent.XXXXXX"
}

# The hostname from an http(s) URL, with a port stripped. Bracketed IPv6 is
# parsed before the generic `host:port` split: `${host%%:*}` on `[::1]:8787`
# would return `[`.
hub_host() {
  local hub="$1" host
  # Userinfo is never a hostname; a URL like http://127.0.0.1:pw@evil would
  # otherwise parse as loopback here while the actual client connects to evil.
  case "$hub" in
    *://*@*) return 1 ;;
  esac
  case "$hub" in
    https://*) host="${hub#https://}" ;;
    http://*) host="${hub#http://}" ;;
    *) return 1 ;;
  esac
  host="${host%%/*}"
  case "$host" in
    \[*\]:*) host="${host#\[}"; host="${host%%\]:*}" ;;
    \[*\]) host="${host#\[}"; host="${host%\]}" ;;
    *:*) host="${host%%:*}" ;;
  esac
  [ -n "$host" ] || return 1
  printf '%s' "$host"
}

hub_is_loopback() {
  case "$(hub_host "$1")" in
    127.0.0.1|localhost|::1) return 0 ;;
  esac
  return 1
}

# The signed-manifest fetch needs HTTPS or a loopback origin. Keep this
# separate from check_hub_url: an insecure non-loopback host is allowed for the
# git helper when the caller opted in, but it must not receive the manifest.
hub_allows_manifest() {
  case "$1" in
    *://*@*) return 1 ;;
    https://?*) [ -n "$(hub_host "$1" 2>/dev/null || true)" ] && return 0; return 1 ;;
    http://*) hub_is_loopback "$1" ;;
    *) return 1 ;;
  esac
}

check_hub_url() {
  local hub="$1" insecure="${2:-}" host
  case "$hub" in
    *://*@*) fail "hub-url must not contain userinfo/credentials" ;;
    https://?*)
      [ -n "$(hub_host "$hub" 2>/dev/null || true)" ] || fail "hub-url has no host"
      return 0
      ;;
    http://?*)
      if hub_is_loopback "$hub"; then return 0; fi
      host="$(hub_host "$hub" 2>/dev/null || true)"
      [ -n "$host" ] || fail "hub-url has no host"
      case ",${insecure// /}," in
        *",$host,"*) return 0 ;;
      esac
      fail "hub-url uses plain HTTP; use https:// or list the host in git-insecure-hosts"
      ;;
    *) fail "hub-url must start with https:// (or loopback http://)" ;;
  esac
}

require_numeric() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}
