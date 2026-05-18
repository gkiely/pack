import { expect, test } from "bun:test";
import { createBootstrapScript } from "./bootstrap-host";

test("createBootstrapScript installs host dependencies and helpers", () => {
  const script = createBootstrapScript();

  expect(script).toContain("apt-get install -y rsync caddy curl ca-certificates sudo golang-go");
  expect(script).toContain("github.com/caddy-dns/vultr");
  expect(script).not.toContain("bun.sh/install");
  expect(script).toContain("useradd --system --create-home --shell /bin/bash pack");
  expect(script).toContain("usermod -a -G pack caddy");
  expect(script).toContain("import /etc/caddy/conf.d/*.caddy");
  expect(script).toContain("cat > /usr/local/bin/pack-write-systemd");
  expect(script).toContain("cat > /usr/local/bin/pack-remove-app");
  expect(script).toContain("go build -o /usr/local/bin/pack-supervisor /tmp/pack-supervisor.go");
  expect(script).toContain("cat > /etc/systemd/system/pack-supervisor.service");
  expect(script).toContain("pack ALL=(root) NOPASSWD: /usr/local/bin/pack-write-systemd");
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
  expect(script).toContain("mkdir -p /var/pack/apps /run/pack/releases /run/pack/ports /etc/pack /etc/caddy/conf.d /etc/caddy/routes.d");
  expect(script).toContain('pack_domain="${PACK_DOMAIN:-}"');
  expect(script).toContain("Domain for pack apps, like example.com:");
  expect(script).toContain('read -r pack_domain < /dev/tty');
  expect(script).toContain('api_key="${API_KEY:-}"');
  expect(script).toContain("Vultr API key for DNS certificates:");
  expect(script).toContain('read -r api_key < /dev/tty');
  expect(script).toContain("printf 'VULTR_API_KEY=%s\\n' \"$api_key\"");
  expect(script).toContain("EnvironmentFile=-/etc/pack/host.env");
  expect(script).not.toContain("/var/pack/baselines");
  expect(script).not.toContain("trusted-token");
  expect(script).toContain("ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile");
  expect(script).toContain("dns vultr {env.VULTR_API_KEY}");
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
