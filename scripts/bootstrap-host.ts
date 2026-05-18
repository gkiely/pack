import { $ } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BOOTSTRAP_TARGET = "root@pack.sh";
const SUPERVISOR_SOURCE = readFileSync(join(import.meta.dir, "pack-supervisor.go"), "utf8");

function helperScripts(): Record<string, string> {
  return {
    "pack-write-systemd": `#!/bin/sh
set -eu

app="$1"
release="$2"
case "$app" in
  *[!a-z0-9-]*|"") echo "invalid app" >&2; exit 1 ;;
esac
case "$release" in
  *[!a-z0-9]*|"") echo "invalid release" >&2; exit 1 ;;
esac

cat > "/etc/systemd/system/pack-$release.service" <<SERVICE
[Unit]
Description=pack release $release for $app
After=network.target

[Service]
ExecStart=/var/pack/apps/$app/releases/$release/app
EnvironmentFile=/run/pack/releases/$release.env
Environment=PACK_ASSETS_DIR=/var/pack/apps/$app/releases/$release/assets
Restart=always
RestartSec=2
User=pack
Group=pack
MemoryMax=256M
CPUQuota=50%
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectClock=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
RestrictRealtime=true
UMask=0027

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
`,
    "pack-remove-app": `#!/bin/sh
set -eu

app="$1"
case "$app" in
  *[!a-z0-9-]*|"") echo "invalid app" >&2; exit 1 ;;
esac

for release_dir in "/var/pack/apps/$app/releases"/*; do
  [ -d "$release_dir" ] || continue
  release="$(basename "$release_dir")"
  systemctl disable --now "pack-$release" 2>/dev/null || true
  rm -f "/etc/systemd/system/pack-$release.service" "/etc/caddy/routes.d/$release.caddy" "/etc/caddy/conf.d/$release.caddy" "/run/pack/releases/$release.env"
done
rm -rf "/var/pack/apps/$app"
systemctl daemon-reload
caddy reload --config /etc/caddy/Caddyfile
`,
  };
}

export function createBootstrapScript(domain?: string): string {
  const domainPrompt =
    domain === undefined
      ? `pack_domain="\${PACK_DOMAIN:-}"
if [ -z "$pack_domain" ]; then
  if [ ! -r /dev/tty ]; then
    echo "PACK_DOMAIN is required when setup is not attached to a terminal" >&2
    exit 1
  fi
  printf "Domain for pack apps, like example.com: " > /dev/tty
  read -r pack_domain < /dev/tty
fi
if [ -z "$pack_domain" ]; then
  echo "domain is required" >&2
  exit 1
fi`
      : `pack_domain=${JSON.stringify(domain)}`;
  const helperInstall = Object.entries(helperScripts())
    .map(
      ([name, content]) => `cat > /usr/local/bin/${name} <<'PACK_HELPER'
${content}PACK_HELPER
chmod 0755 /usr/local/bin/${name}`,
    )
    .join("\n\n");

  return `#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
${domainPrompt}
dns_provider="\${PACK_DNS_PROVIDER:-}"
if [ -z "$dns_provider" ]; then
  if [ ! -r /dev/tty ]; then
    echo "PACK_DNS_PROVIDER is required when setup is not attached to a terminal" >&2
    exit 1
  fi
  printf "DNS provider for TLS certificates [vultr/digitalocean]: " > /dev/tty
  read -r dns_provider < /dev/tty
fi
case "$dns_provider" in
  vultr|digitalocean) ;;
  do) dns_provider="digitalocean" ;;
  "") echo "DNS provider is required" >&2; exit 1 ;;
  *) echo "unsupported DNS provider: $dns_provider" >&2; exit 1 ;;
esac

api_key="\${API_KEY:-}"
if [ -z "$api_key" ]; then
  if [ ! -r /dev/tty ]; then
    echo "API_KEY is required when setup is not attached to a terminal" >&2
    exit 1
  fi
  printf "DNS API key for TLS certificates: " > /dev/tty
  stty -echo < /dev/tty 2>/dev/null || true
  read -r api_key < /dev/tty
  stty echo < /dev/tty 2>/dev/null || true
  printf '\\n' > /dev/tty
fi
if [ -z "$api_key" ]; then
  echo "API_KEY is required" >&2
  exit 1
fi
case "$pack_domain" in
  *[!a-zA-Z0-9.-]*|.*|*..*|*.|"") echo "invalid domain" >&2; exit 1 ;;
esac
case "$dns_provider" in
  vultr)
    caddy_dns_module="github.com/caddy-dns/vultr"
    caddy_dns_module_name="dns.providers.vultr"
    caddy_dns_provider="vultr"
    caddy_dns_env_name="VULTR_API_KEY"
    ;;
  digitalocean)
    caddy_dns_module="github.com/caddy-dns/digitalocean"
    caddy_dns_module_name="dns.providers.digitalocean"
    caddy_dns_provider="digitalocean"
    caddy_dns_env_name="DIGITALOCEAN_API_TOKEN"
    ;;
esac

apt-get update
apt-get install -y rsync caddy curl ca-certificates sudo golang-go

if ! caddy list-modules | grep -q "^$caddy_dns_module_name$"; then
  GOBIN=/usr/local/bin go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
  /usr/local/bin/xcaddy build --with "$caddy_dns_module" --output /tmp/caddy-pack
  install -m 0755 /tmp/caddy-pack /usr/bin/caddy
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/50-cloud-init.conf <<'SSH'
PasswordAuthentication no
SSH
cat > /etc/ssh/sshd_config.d/99-pack-hardening.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
X11Forwarding no
AllowTcpForwarding no
GatewayPorts no
PermitUserEnvironment no
MaxAuthTries 3
SSH
chmod 0600 /etc/ssh/sshd_config.d/50-cloud-init.conf /etc/ssh/sshd_config.d/99-pack-hardening.conf
if command -v sshd >/dev/null 2>&1; then
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

if ! id pack >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash pack
fi
if id caddy >/dev/null 2>&1; then
  usermod -a -G pack caddy
fi

mkdir -p /var/pack/apps /run/pack/releases /run/pack/ports /etc/pack /etc/caddy/conf.d /etc/caddy/routes.d /home/pack/.ssh
chown -R pack:pack /var/pack /home/pack/.ssh
chmod 0700 /home/pack/.ssh
printf '%s=%s\\n' "$caddy_dns_env_name" "$api_key" > /etc/pack/host.env
chmod 0600 /etc/pack/host.env

if [ -f /root/.ssh/authorized_keys ] && [ ! -f /home/pack/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/pack/.ssh/authorized_keys
  chown pack:pack /home/pack/.ssh/authorized_keys
  chmod 0600 /home/pack/.ssh/authorized_keys
fi

mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/no-environ.conf <<'SERVICE'
[Service]
EnvironmentFile=-/etc/pack/host.env
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
SERVICE

cat > /etc/caddy/Caddyfile <<CADDY
import /etc/caddy/conf.d/*.caddy

*.$pack_domain {
  tls {
    dns $caddy_dns_provider {env.$caddy_dns_env_name}
    resolvers 1.1.1.1 8.8.8.8
    propagation_timeout -1
  }
  import /etc/caddy/routes.d/*.caddy
  reverse_proxy unix//run/pack/supervisor.sock
}
CADDY

touch /etc/caddy/conf.d/.keep
touch /etc/caddy/routes.d/.keep

${helperInstall}

rm -f /usr/local/bin/pack-allocate-port /usr/local/bin/pack-ensure-baseline /usr/local/bin/pack-write-caddy /usr/local/bin/pack-write-caddy-static /usr/local/bin/pack-reload /usr/local/bin/pack-reload-static

cat > /tmp/pack-supervisor.go <<'PACK_SUPERVISOR'
${SUPERVISOR_SOURCE}PACK_SUPERVISOR
go build -o /usr/local/bin/pack-supervisor /tmp/pack-supervisor.go

cat > /etc/systemd/system/pack-supervisor.service <<'SERVICE'
[Unit]
Description=pack supervisor
After=network.target

[Service]
ExecStart=/usr/local/bin/pack-supervisor
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectClock=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
RestrictRealtime=true
UMask=0027

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/sudoers.d/pack <<'SUDOERS'
pack ALL=(root) NOPASSWD: /usr/local/bin/pack-write-systemd
pack ALL=(root) NOPASSWD: /usr/local/bin/pack-remove-app
SUDOERS
chmod 0440 /etc/sudoers.d/pack

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable pack-supervisor
systemctl restart pack-supervisor
systemctl enable caddy
systemctl restart caddy

echo "pack host bootstrapped"
`;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const targetArg = argv.find((arg) => arg.startsWith("--target="));
  const domainArg = argv.find((arg) => arg.startsWith("--domain="));
  const target = targetArg ? targetArg.slice("--target=".length) : DEFAULT_BOOTSTRAP_TARGET;
  const script = createBootstrapScript(domainArg ? domainArg.slice("--domain=".length) : "pack.sh");

  if (dryRun) {
    console.log(script);
    return;
  }

  await $`ssh ${target} sh -s < ${new Response(script)}`;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
