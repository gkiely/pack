import { expect, test } from "bun:test";
import { createBootstrapScript } from "./bootstrap-host";

test("createBootstrapScript installs host dependencies and helpers", () => {
  const script = createBootstrapScript();

  expect(script).toContain("apt-get install -y rsync caddy curl ca-certificates sudo golang-go");
  expect(script).toContain("github.com/caddy-dns/vultr");
  expect(script).toContain("github.com/caddy-dns/digitalocean");
  expect(script).not.toContain("bun.sh/install");
  expect(script).toContain("useradd --system --create-home --shell /bin/bash pack");
  expect(script).toContain("usermod -a -G pack caddy");
  expect(script).toContain("import /etc/caddy/conf.d/*.caddy");
  expect(script).toContain("cat > /usr/local/bin/pack-write-systemd");
  expect(script).toContain("cat > /usr/local/bin/pack-remove-app");
  expect(script).toContain("go build -o /usr/local/bin/pack-supervisor /tmp/pack-supervisor.go");
  expect(script).toContain("cat > /etc/systemd/system/pack-supervisor.service");
  expect(script).toContain("pack ALL=(root) NOPASSWD: /usr/local/bin/pack-write-systemd");
  expect(script).toContain("PasswordAuthentication no");
  expect(script).toContain("PermitRootLogin prohibit-password");
  expect(script).toContain("AllowTcpForwarding no");
  expect(script).toContain("ufw --force enable");
  expect(script).not.toContain("cat > /usr/local/bin/pack-ensure-baseline");
  expect(script).not.toContain("pack ALL=(root) NOPASSWD: /usr/local/bin/pack-ensure-baseline");
  expect(script).not.toContain("pack ALL=(root) NOPASSWD: /usr/local/bin/pack-allocate-port");
  expect(script).not.toContain("pack-write-root-caddy");
  expect(script).toContain("caddy validate --config /etc/caddy/Caddyfile");
});

test("createBootstrapScript helper scripts validate names and write expected files", () => {
  const script = createBootstrapScript();

  expect(script).toContain('case "$app" in');
  expect(script).toContain('case "$release" in');
  expect(script).toContain("portStart     = 41001");
  expect(script).toContain("portEnd       = 60999");
  expect(script).toContain('cat > "/etc/systemd/system/pack-$release.service"');
  expect(script).toContain('ExecStart=/var/pack/apps/$app/releases/$release/app');
  expect(script).toContain("EnvironmentFile=/run/pack/releases/$release.env");
  expect(script).toContain("PrivateDevices=true");
  expect(script).toContain("ProtectKernelTunables=true");
  expect(script).toContain("SystemCallArchitectures=native");
  expect(script).toContain("UMask=0027");
  expect(script).toContain("mkdir -p /var/pack/apps /run/pack/releases /run/pack/ports /etc/pack /etc/caddy/conf.d /etc/caddy/routes.d");
  expect(script).toContain('pack_domain="${PACK_DOMAIN:-}"');
  expect(script).toContain('dns_provider="${PACK_DNS_PROVIDER:-}"');
  expect(script).toContain("DNS provider for TLS certificates [vultr/digitalocean]:");
  expect(script).toContain('do) dns_provider="digitalocean"');
  expect(script).toContain("Domain for pack apps, like example.com:");
  expect(script).toContain('read -r pack_domain < /dev/tty');
  expect(script).toContain('api_key="${API_KEY:-}"');
  expect(script).toContain("DNS API key for TLS certificates:");
  expect(script).toContain('read -r api_key < /dev/tty');
  expect(script).toContain('printf \'%s=%s\\n\' "$caddy_dns_env_name" "$api_key"');
  expect(script).toContain('case "$pack_domain" in');
  expect(script).toContain('echo "invalid domain"');
  expect(script).toContain("EnvironmentFile=-/etc/pack/host.env");
  expect(script).not.toContain("/var/pack/baselines");
  expect(script).not.toContain("trusted-token");
  expect(script).toContain("ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile");
  expect(script).toContain("caddy_dns_provider=\"vultr\"");
  expect(script).toContain("caddy_dns_provider=\"digitalocean\"");
  expect(script).toContain("caddy_dns_env_name=\"VULTR_API_KEY\"");
  expect(script).toContain("caddy_dns_env_name=\"DIGITALOCEAN_API_TOKEN\"");
  expect(script).toContain('dns $caddy_dns_provider {env.$caddy_dns_env_name}');
  expect(script).toContain("resolvers 1.1.1.1 8.8.8.8");
  expect(script).toContain("propagation_timeout -1");
  expect(script).toContain("*.$pack_domain {");
  expect(script).toContain("import /etc/caddy/routes.d/*.caddy");
  expect(script).toContain("reverse_proxy unix//run/pack/supervisor.sock");
  expect(script).toContain("systemctl enable pack-supervisor");
  expect(script).toContain("systemctl restart pack-supervisor");
  expect(script).toContain("systemctl restart caddy");
  expect(script).toContain("rm -f /usr/local/bin/pack-allocate-port");
});

test("createBootstrapScript supports custom domains", () => {
  const script = createBootstrapScript("example.com");

  expect(script).toContain('pack_domain="example.com"');
  expect(script).not.toContain("Domain for pack apps");
  expect(script).toContain("*.$pack_domain {");
});
