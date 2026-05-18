import { $ } from "bun";

const DEFAULT_TARGET = "root@pack.sh";

function releaseFromArg(arg: string): string {
  const match = arg.match(/^(?:https?:\/\/)?([a-z0-9]+)(?:\.pack\.sh)?\/?$/);
  if (!match?.[1]) {
    throw new Error("usage: bun run delete:instance <release-id|https://release.pack.sh> [--dry-run]");
  }
  return match[1];
}

function createDeleteScript(): string {
  return `#!/bin/sh
set -eu

release="$1"
dry_run="$2"

case "$release" in
  *[!a-z0-9]*|"") echo "invalid release" >&2; exit 1 ;;
  hello) echo "refusing to delete reserved hello instance" >&2; exit 1 ;;
esac

run() {
  if [ "$dry_run" = 1 ]; then
    printf '+'
    printf ' %s' "$@"
    printf '\\n'
  else
    "$@"
  fi
}

app_root=""
for candidate in /var/pack/apps/*; do
  [ -d "$candidate/releases/$release" ] || continue
  app_root="$candidate"
  break
done

run systemctl disable --now "pack-$release"
run rm -f "/etc/systemd/system/pack-$release.service"
run rm -f "/etc/caddy/routes.d/$release.caddy" "/etc/caddy/conf.d/$release.caddy"
run rm -f "/run/pack/releases/$release.env"

if [ -n "$app_root" ]; then
  run rm -rf "$app_root/releases/$release"

  current=""
  if [ -L "$app_root/current" ]; then
    current="$(basename "$(readlink "$app_root/current")")"
  fi

  if [ "$current" = "$release" ]; then
    next=""
    for release_dir in "$app_root/releases"/*; do
      [ -d "$release_dir" ] || continue
      [ "$(basename "$release_dir")" = "$release" ] && continue
      next="$release_dir"
    done

    if [ -n "$next" ]; then
      run ln -sfn "$next" "$app_root/current"
    else
      run rm -f "$app_root/current"
    fi
  fi
fi

if [ "$dry_run" = 0 ]; then
  systemctl daemon-reload
  caddy reload --config /etc/caddy/Caddyfile
  curl -fsS -X POST http://127.0.0.1:40999/internal/refresh-instances >/dev/null 2>&1 || true
fi
`;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const targetArg = argv.find((arg) => arg.startsWith("--target="));
  const target = targetArg ? targetArg.slice("--target=".length) : DEFAULT_TARGET;
  const releaseArg = argv.find((arg) => !arg.startsWith("--"));
  if (!releaseArg) {
    throw new Error("usage: bun run delete:instance <release-id|https://release.pack.sh> [--dry-run]");
  }

  const release = releaseFromArg(releaseArg);
  await $`ssh ${target} sh -s -- ${release} ${dryRun ? "1" : "0"} < ${new Response(createDeleteScript())}`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
