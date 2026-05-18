import { $ } from "bun";
import { minify } from "html-minifier-terser";
import { join } from "node:path";
import { buildPackBinaries } from "./build-binaries";
import { createBootstrapScript } from "./bootstrap-host";

const root = new URL("..", import.meta.url).pathname;
const siteDir = join(root, "site");
const outDir = join(root, "dist/site");
const binDir = join(outDir, "bin");
const instancesServerPath = join(root, ".pack/pack-instances-server");
const instancesBuildDir = join(root, ".pack/pack-instances-build");
const target = "root@pack.sh";
const remoteRoot = "/var/www/pack.sh";
const remoteInstancesServerPath = "/tmp/pack-instances-server";

await $`rm -rf ${outDir}`;
await $`mkdir -p ${binDir}`;
await $`rm -rf ${instancesBuildDir}`;
await $`mkdir -p ${join(root, ".pack")} ${instancesBuildDir}`;
const indexPath = join(outDir, "index.html");
await $`cp ${join(siteDir, "index.html")} ${indexPath}`;
const minifyHtml = async (html: string) =>
  await minify(html, {
    collapseBooleanAttributes: true,
    collapseWhitespace: true,
    decodeEntities: true,
    minifyCSS: true,
    minifyJS: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    sortAttributes: true,
    sortClassName: true,
  });

await Bun.write(indexPath, await minifyHtml(await Bun.file(indexPath).text()));
await $`cp ${join(root, "scripts/pack-instances-server.go")} ${join(instancesBuildDir, "pack-instances-server.go")}`;
await Bun.write(
  join(instancesBuildDir, "pack-instances.html"),
  await minifyHtml(await Bun.file(join(root, "scripts/pack-instances.html")).text()),
);
await $`cp ${join(siteDir, "install.sh")} ${join(outDir, "install.sh")}`;
await $`cp ${join(siteDir, "install.ps1")} ${join(outDir, "install.ps1")}`;
await $`cp ${join(siteDir, "style.css")} ${join(outDir, "style.css")}`;
await Bun.write(join(outDir, "server.sh"), createBootstrapScript());
await $`cp -R ${join(siteDir, "docs")} ${join(outDir, "docs")}`;
await $`cp ${join(siteDir, "backpack.png")} ${join(outDir, "backpack.png")}`;
await $`cp ${join(siteDir, "backpack-48.png")} ${join(outDir, "backpack-48.png")}`;
await $`cp ${join(siteDir, "backpack-96.png")} ${join(outDir, "backpack-96.png")}`;
await $`cp ${join(siteDir, "backpack-144.png")} ${join(outDir, "backpack-144.png")}`;
await $`cp ${join(siteDir, "pack-og.png")} ${join(outDir, "pack-og.png")}`;
await $`cp ${join(siteDir, "favicon.png")} ${join(outDir, "favicon.png")}`;
await $`cp ${join(siteDir, "favicon.ico")} ${join(outDir, "favicon.ico")}`;
await $`chmod 0644 ${join(outDir, "index.html")} ${join(outDir, "style.css")} ${join(outDir, "install.sh")} ${join(outDir, "install.ps1")} ${join(outDir, "server.sh")} ${join(outDir, "backpack.png")} ${join(outDir, "backpack-48.png")} ${join(outDir, "backpack-96.png")} ${join(outDir, "backpack-144.png")} ${join(outDir, "pack-og.png")} ${join(outDir, "favicon.png")} ${join(outDir, "favicon.ico")}`;
for (const path of [indexPath, join(outDir, "style.css"), join(outDir, "install.sh"), join(outDir, "install.ps1"), join(outDir, "server.sh")]) {
  await $`gzip -kf -9 ${path}`;
  await $`brotli -f -q 11 ${path}`;
}
await buildPackBinaries(binDir);
await $`${[
  "env",
  "GOOS=linux",
  "GOARCH=amd64",
  "CGO_ENABLED=0",
  "go",
  "build",
  "-trimpath",
  "-ldflags=-s -w",
  "-o",
  instancesServerPath,
  join(instancesBuildDir, "pack-instances-server.go"),
]}`;

await $`ssh ${target} mkdir -p ${remoteRoot}`;
await $`rsync -a --delete ${outDir}/ ${target}:${remoteRoot}/`;
await $`rsync -a ${instancesServerPath} ${target}:${remoteInstancesServerPath}`;
await $`ssh ${target} sh -s < ${new Response(`set -eu
install -m 0755 ${remoteInstancesServerPath} /usr/local/bin/pack-instances-server
rm -f ${remoteInstancesServerPath}
rm -rf ${remoteRoot}/tools
cat > /etc/caddy/conf.d/pack-root.caddy <<'CADDY'
pack.sh {
  handle /instances.json {
    reverse_proxy 127.0.0.1:40999
  }

  handle /instances* {
    reverse_proxy 127.0.0.1:40999
  }

  root * ${remoteRoot}
  header /install.sh Content-Type text/plain
  header /install.ps1 Content-Type text/plain
  header /server.sh Content-Type text/plain
  file_server {
    precompressed br gzip
  }
}
CADDY
cat > /etc/systemd/system/pack-instances.service <<'SERVICE'
[Unit]
Description=pack instances API
After=network.target

[Service]
ExecStart=/usr/local/bin/pack-instances-server
Restart=always
RestartSec=2
User=pack
Group=pack
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0027

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now pack-instances.service
systemctl restart pack-instances.service
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
`)}`;

console.log("published https://pack.sh");
