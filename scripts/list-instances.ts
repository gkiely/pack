import { $ } from "bun";

const DEFAULT_TARGET = "root@pack.sh";

const script = `#!/bin/sh
set -eu

printf "APP\\tCURRENT\\tRELEASE\\tPORT\\tSERVICE\\tURL\\n"

for app_root in /var/pack/apps/*; do
  [ -d "$app_root" ] || continue
  app="$(basename "$app_root")"
  current=""
  if [ -L "$app_root/current" ]; then
    current="$(basename "$(readlink "$app_root/current")")"
  fi

  for release_dir in "$app_root/releases"/*; do
    [ -d "$release_dir" ] || continue
    release="$(basename "$release_dir")"
    port=""
    if [ -f "/run/pack/releases/$release.env" ]; then
      port="$(sed -n 's/^PORT=//p' "/run/pack/releases/$release.env" | head -n 1)"
    fi
    service="inactive"
    if systemctl is-active --quiet "pack-$release" 2>/dev/null; then
      service="active"
    elif [ -d "$release_dir/static" ]; then
      service="active"
    fi
    is_current="no"
    [ "$release" = "$current" ] && is_current="yes"
    printf "%s\\t%s\\t%s\\t%s\\t%s\\thttps://%s.pack.sh\\n" "$app" "$is_current" "$release" "$port" "$service" "$release"
  done
done
`;

async function main(argv: string[]): Promise<void> {
  const targetArg = argv.find((arg) => arg.startsWith("--target="));
  const target = targetArg ? targetArg.slice("--target=".length) : DEFAULT_TARGET;
  await $`ssh ${target} sh -s < ${new Response(script)}`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
