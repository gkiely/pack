#!/bin/sh
set -eu

base_url="${PACK_INSTALL_BASE_URL:-https://pack.sh}"
install_dir="${PACK_INSTALL_DIR:-$HOME/.local/bin}"
deploy_host="${PACK_DEPLOY_HOST:-${PACK_HOST:-}}"
release_domain="${PACK_RELEASE_DOMAIN:-${PACK_DOMAIN:-}}"

if [ -z "$deploy_host" ]; then
  if [ ! -r /dev/tty ]; then
    echo "PACK_DEPLOY_HOST is required when install is not attached to a terminal" >&2
    exit 1
  fi
  printf "Deploy host, like pack@example.com: " > /dev/tty
  read -r deploy_host < /dev/tty
fi
if [ -z "$deploy_host" ]; then
  echo "deploy host is required" >&2
  exit 1
fi

if [ -z "$release_domain" ]; then
  if [ ! -r /dev/tty ]; then
    echo "PACK_RELEASE_DOMAIN is required when install is not attached to a terminal" >&2
    exit 1
  fi
  printf "Release domain, like example.com: " > /dev/tty
  read -r release_domain < /dev/tty
fi
if [ -z "$release_domain" ]; then
  echo "release domain is required" >&2
  exit 1
fi
case "$deploy_host" in
  *[!a-zA-Z0-9@._:-]*|*@|@*|*::*|"") echo "invalid deploy host" >&2; exit 1 ;;
esac
case "$release_domain" in
  *[!a-zA-Z0-9.-]*|.*|*..*|*.|"") echo "invalid release domain" >&2; exit 1 ;;
esac

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  x86_64|amd64) cpu="x64" ;;
  arm64|aarch64) cpu="arm64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

url="$base_url/bin/pack-$platform-$cpu"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

mkdir -p "$install_dir"
curl -fsSL "$url" -o "$tmp"
chmod 0755 "$tmp"
mv "$tmp" "$install_dir/pack"

echo "installed pack to $install_dir/pack"

quoted_install_dir="$(shell_quote "$install_dir")"
quoted_deploy_host="$(shell_quote "$deploy_host")"
quoted_release_domain="$(shell_quote "$release_domain")"
config_line="export PATH=$quoted_install_dir:\$PATH"
deploy_host_line=""
release_domain_line=""
[ -n "$deploy_host" ] && deploy_host_line="export PACK_DEPLOY_HOST=$quoted_deploy_host"
[ -n "$release_domain" ] && release_domain_line="export PACK_RELEASE_DOMAIN=$quoted_release_domain"
refresh_command=""
path_line_needed=1
case ":$PATH:" in
  *":$install_dir:"*) path_line_needed=0 ;;
esac

case "$(basename "${SHELL:-}")" in
  zsh)
    shell_config="$HOME/.zshrc"
    if [ -w "$shell_config" ]; then
      {
        printf "\n# pack\n"
        if [ "$path_line_needed" -eq 1 ] && ! grep -Fq "$config_line" "$shell_config"; then
          printf "%s\n" "$config_line"
        fi
        if [ -n "$deploy_host_line" ] && ! grep -Fq "PACK_DEPLOY_HOST=" "$shell_config"; then
          printf "%s\n" "$deploy_host_line"
        fi
        if [ -n "$release_domain_line" ] && ! grep -Fq "PACK_RELEASE_DOMAIN=" "$shell_config"; then
          printf "%s\n" "$release_domain_line"
        fi
      } >> "$shell_config"
      echo "updated pack shell config in $shell_config"
      refresh_command="exec $SHELL"
    fi
    ;;
  bash)
    for shell_config in "$HOME/.bash_profile" "$HOME/.bashrc"; do
      if [ -w "$shell_config" ]; then
        {
          printf "\n# pack\n"
          if [ "$path_line_needed" -eq 1 ] && ! grep -Fq "$config_line" "$shell_config"; then
            printf "%s\n" "$config_line"
          fi
          if [ -n "$deploy_host_line" ] && ! grep -Fq "PACK_DEPLOY_HOST=" "$shell_config"; then
            printf "%s\n" "$deploy_host_line"
          fi
          if [ -n "$release_domain_line" ] && ! grep -Fq "PACK_RELEASE_DOMAIN=" "$shell_config"; then
            printf "%s\n" "$release_domain_line"
          fi
        } >> "$shell_config"
        echo "updated pack shell config in $shell_config"
        refresh_command=". $shell_config"
        break
      fi
    done
    ;;
  fish)
    shell_config="$HOME/.config/fish/config.fish"
    fish_line="fish_add_path $install_dir"
    if [ -w "$shell_config" ]; then
      {
        printf "\n# pack\n"
        if [ "$path_line_needed" -eq 1 ] && ! grep -Fq "$fish_line" "$shell_config"; then
          printf "%s\n" "$fish_line"
        fi
        if [ -n "$deploy_host" ] && ! grep -Fq "PACK_DEPLOY_HOST" "$shell_config"; then
          printf "set -gx PACK_DEPLOY_HOST %s\n" "$quoted_deploy_host"
        fi
        if [ -n "$release_domain" ] && ! grep -Fq "PACK_RELEASE_DOMAIN" "$shell_config"; then
          printf "set -gx PACK_RELEASE_DOMAIN %s\n" "$quoted_release_domain"
        fi
      } >> "$shell_config"
      echo "updated pack shell config in $shell_config"
      refresh_command=". $shell_config"
    fi
    ;;
esac

if [ -z "$refresh_command" ]; then
  echo "add this to your shell config to run pack from any directory:"
  [ "$path_line_needed" -eq 1 ] && echo "$config_line"
  [ -n "$deploy_host_line" ] && echo "$deploy_host_line"
  [ -n "$release_domain_line" ] && echo "$release_domain_line"
else
  echo "to get started, run:"
  echo "  $refresh_command"
fi
