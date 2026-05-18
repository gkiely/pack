import { $ } from "bun";

const DEFAULT_TARGET = "root@pack.sh";

function createDeleteScript(dryRun: boolean): string {
  const run = dryRun ? "echo" : "";

  return `#!/bin/sh
set -eu

dry_run=${dryRun ? "1" : "0"}

for service in /etc/systemd/system/pack-*.service; do
  [ -f "$service" ] || continue
  service_name="$(basename "$service")"
  case "$service_name" in
    pack-reserved-hello.service|pack-instances.service|pack-supervisor.service)
      continue
      ;;
  esac
  release="\${service_name%.service}"
  release="\${release#pack-}"
  ${run} systemctl disable --now "$service_name" 2>/dev/null || true
  ${run} rm -f "$service"
done

for app_root in /var/pack/apps/*; do
  [ -e "$app_root" ] || continue
  ${run} rm -rf "$app_root"
done

for snippet in /etc/caddy/routes.d/*.caddy /etc/caddy/conf.d/*.caddy; do
  [ -f "$snippet" ] || continue
  snippet_name="$(basename "$snippet")"
  case "$snippet_name" in
    pack-root.caddy|hello.caddy)
      continue
      ;;
    *.legacy-*)
      ;;
  esac
  if [ "$snippet_name" = ".keep" ]; then
    continue
  fi
  ${run} rm -f "$snippet"
done

for env_file in /run/pack/releases/*.env; do
  [ -f "$env_file" ] || continue
  ${run} rm -f "$env_file"
done

for port_file in /run/pack/ports/* /var/pack/ports/*; do
  [ -f "$port_file" ] || continue
  ${run} rm -f "$port_file"
done

for cert_dir in /var/lib/caddy/.local/share/caddy/certificates/*/*.pack.sh; do
  [ -d "$cert_dir" ] || continue
  name="$(basename "$cert_dir")"
  case "$name" in
    pack.sh|wildcard_.pack.sh) continue ;;
  esac
  ${run} rm -rf "$cert_dir"
done

if [ "$dry_run" = 0 ]; then
  systemctl daemon-reload
  caddy reload --config /etc/caddy/Caddyfile
fi
`;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const targetArg = argv.find((arg) => arg.startsWith("--target="));
  const target = targetArg ? targetArg.slice("--target=".length) : DEFAULT_TARGET;

  await $`ssh ${target} sh -s < ${new Response(createDeleteScript(dryRun))}`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
