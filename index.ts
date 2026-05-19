import { $ } from "bun";
import { parse } from "acorn";
import { release } from "node:os";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

type PackBuild = string | string[];

type PackConfigFile = {
  name?: string;
  entry?: string;
  artifact?: string;
  assets?: string[];
  build?: PackBuild;
};

type PackageJson = {
  name?: string;
  module?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type DeployTarget = {
  username: string;
  host: string;
  port: number;
};

export type PackConfig = {
  name: string;
  type: string;
  entry: string;
  artifact: string;
  assets: string[];
  build: PackBuild;
};

export type DeployPlan = {
  config: PackConfig;
  mode: "executable" | "static";
  deployHost: string;
  releaseDomain: string;
  releaseId: string;
  appRoot: string;
  cachePath: string;
  releasePath: string;
  releaseUrl: string;
  buildCommand: string[];
  preUploadRemoteCommands: string[];
  rsyncCommands: string[][];
  remoteCommands: string[];
  systemdService: string;
  metadata: string;
  rollbackSteps: string[];
};

const DEFAULT_ARTIFACT = ".pack/app";
const BUN_TARGET = "bun-linux-x64-baseline";
const DEFAULT_DEPLOY_HOST = "pack@pack.sh";
const DEFAULT_RELEASE_DOMAIN = "pack.sh";
const RELEASE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const VERSION = "0.0.0";
const PROJECT_TYPES = ["bun", "node", "deno", "go", "rust", "zig", "c", "cpp"] as const;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const ALWAYS_IGNORED_SCAN_DIRS = new Set([".git", ".pack", "node_modules"]);
export const DYNAMIC_MODULE_IMPORT_WARNING_PREFIX = "Warning: found dynamic module imports in";
export const DYNAMIC_MODULE_IMPORT_WARNING =
  "Single-file builds may not include modules loaded with import(path) or require(variable). Use static imports, include those files as assets, or provide a custom build command.";

type ProjectType = (typeof PROJECT_TYPES)[number];
type LocalShellKind = "posix" | "windows";

export function formatHelp(): string {
  return `pack ${VERSION}

Usage:
  pack               Initialize pack.json if needed, then deploy
  pack --dry-run     Print the deploy plan without deploying
  pack --emit <dir>  Write systemd, metadata, and remote command files
  pack -v            Print the pack version
  pack --version     Print the pack version
  pack --help        Show this help menu
`;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_@$%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandToString(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

function andCommands(commands: string[]): string {
  return commands.join(" && ");
}

function normalizeDeployHost(target: string): string {
  if (target.includes("@")) return target;
  return `pack@${target}`;
}

function deployHost(): string {
  return normalizeDeployHost(process.env.PACK_DEPLOY_HOST || process.env.PACK_HOST || DEFAULT_DEPLOY_HOST);
}

function releaseDomain(): string {
  return process.env.PACK_RELEASE_DOMAIN || process.env.PACK_DOMAIN || DEFAULT_RELEASE_DOMAIN;
}

function parseDeployTarget(target: string): DeployTarget {
  const atIndex = target.indexOf("@");
  const username = atIndex === -1 ? "" : target.slice(0, atIndex);
  const hostAndPort = atIndex === -1 ? target : target.slice(atIndex + 1);
  const colonIndex = hostAndPort.indexOf(":");
  const host = colonIndex === -1 ? hostAndPort : hostAndPort.slice(0, colonIndex);
  const rawPort = colonIndex === -1 ? "" : hostAndPort.slice(colonIndex + 1);
  return {
    username,
    host,
    port: rawPort ? Number(rawPort) : 22,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return (await file.json()) as T;
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

type AstNode = {
  type?: string;
  [key: string]: unknown;
};

function isStaticModuleSpecifier(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as AstNode;
  if (candidate.type === "Literal" && typeof candidate.value === "string") return true;
  if (candidate.type !== "TemplateLiteral") return false;
  const expressions = candidate.expressions;
  return Array.isArray(expressions) && expressions.length === 0;
}

function startsWithRelativeSpecifier(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as AstNode;
  if (candidate.type === "Literal") {
    return typeof candidate.value === "string" && /^\.{1,2}\//.test(candidate.value);
  }
  if (candidate.type === "TemplateLiteral") {
    const quasis = candidate.quasis;
    const first = Array.isArray(quasis) ? (quasis[0] as AstNode | undefined) : undefined;
    const value = first?.value as { raw?: unknown } | undefined;
    return typeof value?.raw === "string" && /^\.{1,2}\//.test(value.raw);
  }
  if (candidate.type === "BinaryExpression" && candidate.operator === "+") {
    return startsWithRelativeSpecifier(candidate.left);
  }
  return false;
}

function hasDynamicModuleImport(path: string, text: string, type: string): boolean {
  let parsed: unknown;
  try {
    parsed = parse(text, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {
    parsed = parse(text, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  }

  function isRiskySpecifier(node: unknown): boolean {
    if (isStaticModuleSpecifier(node)) return false;
    if (type === "node" && startsWithRelativeSpecifier(node)) {
      return false;
    }
    return true;
  }

  function visit(node: unknown): boolean {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) {
      return node.some(visit);
    }

    const candidate = node as AstNode;
    if (candidate.type === "ImportExpression" && isRiskySpecifier(candidate.source)) {
      return true;
    }
    if (
      candidate.type === "CallExpression" &&
      candidate.callee &&
      typeof candidate.callee === "object" &&
      (candidate.callee as AstNode).type === "Identifier" &&
      (candidate.callee as AstNode).name === "require"
    ) {
      const args = candidate.arguments;
      if (Array.isArray(args) && isRiskySpecifier(args[0])) return true;
    }

    for (const [key, value] of Object.entries(candidate)) {
      if (key === "parent") {
        continue;
      }
      if (visit(value)) return true;
    }
    return false;
  }

  return visit(parsed);
}

async function scanIgnoredDirs(root = process.cwd()): Promise<Set<string>> {
  const ignored = new Set(ALWAYS_IGNORED_SCAN_DIRS);
  const gitignore = Bun.file(join(root, ".gitignore"));
  if (!(await gitignore.exists())) return ignored;

  for (const rawLine of (await gitignore.text()).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.includes("*")) {
      continue;
    }
    const normalized = line.replace(/\/+$/, "");
    if (!normalized || normalized.includes("/")) {
      continue;
    }
    ignored.add(normalized);
  }
  return ignored;
}

function appNameFromPackageName(name: string): string {
  return name
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requireAppName(name: string): string {
  if (name) return name;
  throw new Error("package.json must include name");
}

export function createReleaseId(length = 7): string {
  let id = "";
  for (let i = 0; i < length; i += 1) {
    id += RELEASE_ALPHABET[Math.floor(Math.random() * RELEASE_ALPHABET.length)];
  }
  return id;
}

export async function loadPackConfig(path = "pack.json"): Promise<PackConfig> {
  const raw = (await readJsonIfExists<PackConfigFile>(path)) ?? {};
  const packageJson = await readJsonIfExists<PackageJson>("package.json");
  const inferredName =
    typeof packageJson?.name === "string" ? appNameFromPackageName(packageJson.name) : "";
  const assets = Array.isArray(raw.assets)
    ? raw.assets
    : (await directoryExists("public"))
      ? ["public"]
      : [];
  const artifact = raw.artifact ?? DEFAULT_ARTIFACT;
  const build = requireBuildCommand(raw.build, artifact);

  return {
    name: requireAppName(raw.name ?? inferredName),
    type: inferAppType(build),
    entry: raw.entry ?? "src/index.ts",
    artifact,
    assets,
    build,
  };
}

function normalizeProjectType(value: string | undefined): ProjectType | undefined {
  if (!value) return undefined;
  const type = value.toLowerCase();
  if (type === "nodejs") return "node";
  return PROJECT_TYPES.find((projectType) => projectType === type);
}

async function detectProjectType(packageJson: PackageJson | undefined): Promise<ProjectType | undefined> {
  if (await fileExists("go.mod")) return "go";
  if (await fileExists("Cargo.toml")) return "rust";
  if (await fileExists("build.zig")) return "zig";
  if (await fileExists("src/main.zig")) return "zig";
  if ((await fileExists("src/main.cpp")) || (await fileExists("main.cpp"))) return "cpp";
  if ((await fileExists("src/main.c")) || (await fileExists("main.c"))) return "c";
  if ((await fileExists("deno.json")) || (await fileExists("deno.jsonc")) || (await fileExists("deno.lock"))) {
    return "deno";
  }

  const scripts = Object.values(packageJson?.scripts ?? {});
  const dependencies = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const hasBunLock = (await fileExists("bun.lock")) || (await fileExists("bun.lockb"));
  const hasBunSignal =
    hasBunLock ||
    (await fileExists("bunfig.toml")) ||
    typeof packageJson?.module === "string" ||
    Boolean(dependencies["@types/bun"] || dependencies["bun-types"]) ||
    scripts.some((script) => /\bbun(?:x| run)?\b/.test(script));

  if (hasBunSignal) return "bun";

  const hasNodeSignal =
    (await fileExists("build-sea.mjs")) ||
    (await fileExists("build-sea.js")) ||
    (await fileExists("package-lock.json")) ||
    (await fileExists("pnpm-lock.yaml")) ||
    (await fileExists("yarn.lock")) ||
    Boolean(dependencies["@types/node"]) ||
    scripts.some((script) => /\bnode\b/.test(script));

  if (hasNodeSignal) {
    return "node";
  }
  return undefined;
}

async function promptProjectType(): Promise<ProjectType> {
  if (!process.stdin.isTTY) {
    throw new Error("Could not detect project type. Run pack in a TTY or create pack.json.");
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      console.log("Select project type:");
      PROJECT_TYPES.forEach((type, index) => {
        console.log(`  ${index + 1}. ${type}`);
      });

      const answer = (await terminal.question("> ")).trim();
      const selectedByNumber = PROJECT_TYPES[Number(answer) - 1];
      const selected = selectedByNumber ?? normalizeProjectType(answer);
      if (selected) return selected;
      console.log(`Choose one of: ${PROJECT_TYPES.join(", ")}`);
    }
  } finally {
    terminal.close();
  }
}

async function rustBinaryName(packageName: string): Promise<string> {
  const cargoToml = await Bun.file("Cargo.toml").text();
  const match = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? packageName;
}

export function isWslEnvironment(
  platform = process.platform,
  osRelease = release(),
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  return (
    platform === "linux" &&
    (Boolean(env.WSL_DISTRO_NAME) || Boolean(env.WSL_INTEROP) || osRelease.toLowerCase().includes("microsoft"))
  );
}

export function detectLocalShellKind(
  platform = process.platform,
  osRelease = release(),
  env: Record<string, string | undefined> = Bun.env,
): LocalShellKind {
  if (isWslEnvironment(platform, osRelease, env)) return "posix";
  if (platform === "win32") return "windows";
  return "posix";
}

function goBuildCommand(shellKind = detectLocalShellKind()): string {
  if (shellKind === "windows") {
    return 'set "GOOS=linux" && set "GOARCH=amd64" && set "CGO_ENABLED=0" && go build -trimpath -ldflags="-s -w" -o .pack/app .';
  }

  return "GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o .pack/app .";
}

function rustBuildCommand(binaryName: string, shellKind = detectLocalShellKind()): string {
  if (shellKind === "windows") {
    return `cargo build --release --target x86_64-unknown-linux-gnu && copy target\\x86_64-unknown-linux-gnu\\release\\${binaryName} .pack\\app`;
  }

  return `cargo build --release --target x86_64-unknown-linux-gnu && cp target/x86_64-unknown-linux-gnu/release/${binaryName} .pack/app`;
}

async function createPackConfigFile(type: ProjectType, packageJson: PackageJson | undefined): Promise<PackConfigFile> {
  const name =
    typeof packageJson?.name === "string"
      ? appNameFromPackageName(packageJson.name)
      : appNameFromPackageName(basename(process.cwd()));

  if (type === "go") {
    return {
      name,
      build: goBuildCommand(),
    };
  }

  if (type === "rust") {
    const binaryName = await rustBinaryName(name);
    return {
      name,
      build: rustBuildCommand(binaryName),
    };
  }

  if (type === "zig") {
    return {
      name,
      build: "zig build-exe src/main.zig -O ReleaseSmall -target x86_64-linux-gnu -lc -femit-bin=.pack/app",
    };
  }

  if (type === "c") {
    return {
      name,
      build: "zig cc src/main.c -target x86_64-linux-gnu -O2 -s -o .pack/app",
    };
  }

  if (type === "cpp") {
    return {
      name,
      build: "zig c++ src/main.cpp -target x86_64-linux-gnu -O2 -s -Wno-nullability-completeness -o .pack/app",
    };
  }

  if (type === "node") {
    return {
      name,
      build: "node build-sea.mjs",
    };
  }

  if (type === "deno") {
    return {
      name,
      build: "deno compile --allow-net --allow-env --target x86_64-unknown-linux-gnu --output .pack/app src/main.ts",
    };
  }

  return {
    name,
    build: `bun build ./src/index.ts --compile --minify --target=${BUN_TARGET} --outfile .pack/app`,
  };
}

export async function ensurePackConfig(path = "pack.json"): Promise<void> {
  if (await fileExists(path)) return;

  const packageJson = await readJsonIfExists<PackageJson>("package.json");
  const detected = await detectProjectType(packageJson);
  const type = detected ?? (await promptProjectType());
  const config = await createPackConfigFile(type, packageJson);

  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Created ${path} for ${type}`);
}

function requireBuildCommand(
  build: PackBuild | undefined,
  artifact: string,
): PackBuild {
  if (typeof build === "string" && build.trim()) return build;
  if (Array.isArray(build) && build.length > 0) return build;
  throw new Error(`pack.json must include a build command that creates ${artifact}`);
}

function inferAppType(build: PackBuild): string {
  const command = Array.isArray(build) ? build.join(" ") : build;
  if (/\bgo build\b/.test(command)) return "go";
  if (/\bcargo build\b/.test(command)) return "rust";
  if (/\bzig c\+\+/.test(command)) return "cpp";
  if (/\bzig cc\b/.test(command)) return "c";
  if (/\bzig\b/.test(command)) return "zig";
  if (/\bdeno compile\b/.test(command)) return "deno";
  if (/\bbuild-sea\.mjs\b|\bnode\b/.test(command)) return "node";
  if (/\bbun build\b/.test(command)) return "bun";
  return "unknown";
}

export function createBuildCommand(config: PackConfig): string[] {
  if (Array.isArray(config.build)) return config.build;
  if (detectLocalShellKind() === "windows") return ["cmd", "/d", "/s", "/c", config.build];
  return ["sh", "-lc", config.build];
}

async function findDynamicModuleImportFiles(
  type: string,
  ignoredDirs: Set<string>,
  dir = process.cwd(),
  found: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        await findDynamicModuleImportFiles(type, ignoredDirs, path, found);
      }
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
      continue;
    }
    const text = await Bun.file(path).text();
    if (hasDynamicModuleImport(path, text, type)) {
      found.push(path);
    }
  }

  return found;
}

export async function dynamicModuleImportWarnings(config: PackConfig): Promise<string[]> {
  if (!["bun", "node", "deno"].includes(config.type)) return [];

  const files = await findDynamicModuleImportFiles(config.type, await scanIgnoredDirs());
  if (files.length === 0) return [];

  const relativeFiles = files.map((file) =>
    file.startsWith(`${process.cwd()}/`) ? file.slice(process.cwd().length + 1) : file,
  );
  return [
    `${DYNAMIC_MODULE_IMPORT_WARNING_PREFIX} ${relativeFiles.join(", ")}.`,
    DYNAMIC_MODULE_IMPORT_WARNING,
  ];
}

export function createSystemdService(config: PackConfig, releaseId: string): string {
  const appRoot = `/var/pack/apps/${config.name}`;
  return `[Unit]
Description=pack release ${releaseId} for ${config.name}
After=network.target

[Service]
ExecStart=${appRoot}/releases/${releaseId}/app
EnvironmentFile=/run/pack/releases/${releaseId}.env
Environment=PACK_ASSETS_DIR=${appRoot}/releases/${releaseId}/assets
Restart=always
RestartSec=2
User=pack
Group=pack
MemoryMax=256M
CPUQuota=50%
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export function createReleaseMetadata(
  config: PackConfig,
  releaseId: string,
  mode: "executable" | "static",
): string {
  const appRoot = `/var/pack/apps/${config.name}`;
  return `${JSON.stringify(
    {
      app: config.name,
      release: releaseId,
      kind: mode,
      ...(mode === "executable"
        ? { service: `pack-${releaseId}.service` }
        : { root: `${appRoot}/releases/${releaseId}/static` }),
      type: config.type,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}

function createWriteMetadataCommand(
  config: PackConfig,
  releaseId: string,
  mode: "executable" | "static",
  metadataPath: string,
): string {
  const metadata = createReleaseMetadata(config, releaseId, mode);
  return `printf '%s' ${shellQuote(metadata)} > ${shellQuote(metadataPath)}`;
}

export function createDeployPlan(
  config: PackConfig,
  releaseId = createReleaseId(),
  mode: "executable" | "static" = "executable",
): DeployPlan {
  const targetHost = deployHost();
  const targetDomain = releaseDomain();
  const appRoot = `/var/pack/apps/${config.name}`;
  const cachePath = `${appRoot}/cache`;
  const releasePath = `${appRoot}/releases/${releaseId}`;
  const staticCachePath = `${cachePath}/static`;
  const prepareAppCacheCommand = andCommands([
    `mkdir -p ${shellQuote(cachePath)} ${shellQuote(`${appRoot}/releases`)}`,
    "rsync",
  ]);
  const rsyncCommands =
    mode === "static"
      ? [
          [
            "rsync",
            "-aP",
            "--delete",
            "--rsync-path",
            andCommands([
              `rm -rf ${shellQuote(staticCachePath)}`,
              `mkdir -p ${shellQuote(staticCachePath)}`,
              "rsync",
            ]),
            ".pack/static/",
            `${targetHost}:${staticCachePath}/`,
          ],
        ]
      : [
          [
            "rsync",
            "-P",
            "--stats",
            "--ignore-times",
            "--no-whole-file",
            "--inplace",
            "--rsync-path",
            prepareAppCacheCommand,
            config.artifact,
            `${targetHost}:${cachePath}/app`,
          ],
          ...config.assets.map((asset) => {
      const assetCachePath = `${cachePath}/assets/${basename(asset)}`;
      return [
        "rsync",
        "-aP",
        "--delete",
        "--rsync-path",
        andCommands([
          `rm -rf ${shellQuote(assetCachePath)}`,
          `mkdir -p ${shellQuote(assetCachePath)}`,
          "rsync",
        ]),
        `${asset.replace(/\/$/, "")}/`,
        `${targetHost}:${assetCachePath}/`,
      ];
    }),
        ];
  const preUploadRemoteCommands =
    mode === "static"
      ? [
          `mkdir -p ${shellQuote(cachePath)} ${shellQuote(`${appRoot}/releases`)}`,
          `rm -rf ${shellQuote(staticCachePath)}`,
          `mkdir -p ${shellQuote(staticCachePath)}`,
        ]
      : [
          `mkdir -p ${shellQuote(cachePath)} ${shellQuote(`${appRoot}/releases`)}`,
          ...config.assets.map((asset) => `rm -rf ${shellQuote(`${cachePath}/assets/${basename(asset)}`)}`),
          ...config.assets.map(
            (asset) => `mkdir -p ${shellQuote(`${cachePath}/assets/${basename(asset)}`)}`,
          ),
        ];

  const remoteCommands =
    mode === "static"
      ? [
          `[ ! -e ${shellQuote(releasePath)} ]`,
          `mkdir -p ${shellQuote(releasePath)}`,
          `cp -R ${shellQuote(staticCachePath)} ${shellQuote(`${releasePath}/static`)}`,
          `printf '%s\\n' static > ${shellQuote(`${releasePath}/type`)}`,
          `printf '%s\\n' ${shellQuote(config.type)} > ${shellQuote(`${releasePath}/app-type`)}`,
          createWriteMetadataCommand(config, releaseId, mode, `${releasePath}/metadata.json`),
          `ln -sfn ${shellQuote(releasePath)} ${shellQuote(`${appRoot}/current`)}`,
          `curl -fsS -X POST http://127.0.0.1:40999/internal/refresh-instances >/dev/null 2>&1 || true`,
        ]
      : [
          `[ ! -e ${shellQuote(releasePath)} ]`,
          `mkdir -p ${shellQuote(releasePath)}`,
          `cp ${shellQuote(`${cachePath}/app`)} ${shellQuote(`${releasePath}/app`)}`,
          `mkdir -p ${shellQuote(`${releasePath}/assets`)}`,
          `if [ -d ${shellQuote(`${cachePath}/assets`)} ]; then cp -R ${shellQuote(`${cachePath}/assets/.`)} ${shellQuote(`${releasePath}/assets/`)}; fi`,
          `printf '%s\\n' ${shellQuote(config.type)} > ${shellQuote(`${releasePath}/type`)}`,
          `chmod +x ${shellQuote(`${releasePath}/app`)}`,
          createWriteMetadataCommand(config, releaseId, mode, `${releasePath}/metadata.json`),
          `previous="$(readlink ${shellQuote(`${appRoot}/current`)} 2>/dev/null || true)"`,
          `previous_release="$(basename "$previous" 2>/dev/null || true)"`,
          `ln -sfn ${shellQuote(releasePath)} ${shellQuote(`${appRoot}/current`)}`,
          `sudo /usr/local/bin/pack-write-systemd ${shellQuote(config.name)} ${shellQuote(releaseId)}`,
          `curl --unix-socket /run/pack/supervisor.sock -fsS -X POST ${shellQuote(`http://pack-supervisor/releases/${releaseId}/start`)}`,
          `if [ -n "$previous_release" ] && [ "$previous_release" != ${shellQuote(releaseId)} ]; then curl --unix-socket /run/pack/supervisor.sock -fsS -X POST "http://pack-supervisor/releases/$previous_release/stop" >/dev/null 2>&1 || true; fi`,
          `curl -fsS -X POST http://127.0.0.1:40999/internal/refresh-instances >/dev/null 2>&1 || true`,
        ];

  return {
    config,
    mode,
    deployHost: targetHost,
    releaseDomain: targetDomain,
    releaseId,
    appRoot,
    cachePath,
    releasePath,
    releaseUrl: `https://${releaseId}.${targetDomain}`,
    buildCommand: createBuildCommand(config),
    preUploadRemoteCommands,
    rsyncCommands,
    remoteCommands,
    systemdService: mode === "static" ? "" : createSystemdService(config, releaseId),
    metadata: createReleaseMetadata(config, releaseId, mode),
    rollbackSteps: [
      "build fails: stop locally, do not SSH",
      "upload fails: leave current symlink unchanged",
      "restart fails: revert current symlink to previous release",
      "supervisor start fails: revert current symlink to previous release",
      "health check fails: revert current symlink to previous release",
    ],
  };
}

export function formatDryRun(plan: DeployPlan): string {
  const fallbackUpload =
    plan.mode === "static"
      ? [`scp -r .pack/static/. ${plan.deployHost}:${plan.cachePath}/static/`]
      : [
          `scp ${plan.config.artifact} ${plan.deployHost}:${plan.cachePath}/app`,
          ...plan.config.assets.map(
            (asset) =>
              `scp -r ${asset.replace(/\/$/, "")}/. ${plan.deployHost}:${plan.cachePath}/assets/${basename(asset)}/`,
          ),
        ];

  return [
    `release id: ${plan.releaseId}`,
    `release url: ${plan.releaseUrl}`,
    `app root: ${plan.appRoot}`,
    "",
    "build command:",
    commandToString(plan.buildCommand),
    "",
    "pre-upload remote commands:",
    ...plan.preUploadRemoteCommands.map((command) => `ssh ${plan.deployHost} ${shellQuote(command)}`),
    "",
    "upload commands (rsync when available):",
    ...plan.rsyncCommands.map(commandToString),
    "",
    "upload commands (cross-platform fallback):",
    ...fallbackUpload,
    "",
    "remote commands:",
    ...plan.remoteCommands,
    "",
    "rollback steps:",
    ...plan.rollbackSteps.map((step) => `- ${step}`),
  ].join("\n");
}

export async function emitPlan(plan: DeployPlan, outDir: string): Promise<void> {
  const systemdDir = join(outDir, "systemd");
  await mkdir(systemdDir, { recursive: true });
  if (plan.systemdService) {
    await Bun.write(join(systemdDir, `pack-${plan.releaseId}.service`), plan.systemdService);
  }
  await Bun.write(join(outDir, "metadata.json"), plan.metadata);
  await Bun.write(
    join(outDir, "remote-commands.sh"),
    `#!/bin/sh
set -eu

${plan.remoteCommands.join("\n")}
`,
  );
}

async function build(plan: DeployPlan): Promise<void> {
  await rm(".pack", { recursive: true, force: true });
  await mkdir(".pack", { recursive: true });
  await $`${plan.buildCommand}`.quiet();
}

async function detectBuildOutput(): Promise<"executable" | "static"> {
  if (await Bun.file(DEFAULT_ARTIFACT).exists()) return "executable";
  if (await directoryExists(".pack/static")) return "static";
  throw new Error("Build must create .pack/app or .pack/static");
}

async function printBuildOutput(mode: "executable" | "static"): Promise<void> {
  if (mode === "static") {
    console.log("Built .pack/static");
    return;
  }

  const artifact = Bun.file(DEFAULT_ARTIFACT);
  const stat = await artifact.stat();
  console.log(`Built ${DEFAULT_ARTIFACT}`);
  console.log(`Size: ${stat.size}`);
}

async function hasCommand(command: string): Promise<boolean> {
  const lookup = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = await $`${[lookup, ...args]}`.quiet().nothrow();
  return result.exitCode === 0;
}

async function sshExec(target: string, script: string): Promise<void> {
  await $`ssh ${target} sh -s < ${new Response(script)}`;
}

async function uploadDirectoryWithScp(target: string, localDir: string, remoteDir: string): Promise<void> {
  await sshExec(target, `set -eu\nmkdir -p ${shellQuote(remoteDir)}\n`);
  for (const entry of await readdir(localDir, { withFileTypes: true })) {
    const localPath = join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await uploadDirectoryWithScp(target, localPath, remotePath);
    } else if (entry.isFile()) {
      await $`scp ${localPath} ${`${target}:${remotePath}`}`;
    }
  }
}

async function uploadWithRsync(plan: DeployPlan): Promise<void> {
  for (const command of plan.rsyncCommands) {
    await $`${command}`;
  }

  await $`ssh ${plan.deployHost} sh -s < ${new Response(`set -eu\n\n${plan.remoteCommands.join("\n")}\n`)}`;
}

async function uploadWithScp(plan: DeployPlan): Promise<void> {
  await sshExec(plan.deployHost, `set -eu\n\n${plan.preUploadRemoteCommands.join("\n")}\n`);

  if (plan.mode === "static") {
    await uploadDirectoryWithScp(plan.deployHost, ".pack/static", `${plan.cachePath}/static`);
  } else {
    await $`scp ${plan.config.artifact} ${`${plan.deployHost}:${plan.cachePath}/app`}`;
    for (const asset of plan.config.assets) {
      const localDir = asset.replace(/\/$/, "");
      await uploadDirectoryWithScp(plan.deployHost, localDir, `${plan.cachePath}/assets/${basename(asset)}`);
    }
  }

  await sshExec(plan.deployHost, `set -eu\n\n${plan.remoteCommands.join("\n")}\n`);
}

async function deploy(plan: DeployPlan): Promise<void> {
  const [hasRsync, hasSsh, hasScp] = await Promise.all([hasCommand("rsync"), hasCommand("ssh"), hasCommand("scp")]);
  if (hasRsync && hasSsh) {
    await uploadWithRsync(plan);
  } else if (hasSsh && hasScp) {
    await uploadWithScp(plan);
  } else {
    throw new Error("pack deploy requires ssh and scp, or ssh and rsync");
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(formatHelp());
    return;
  }

  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(`pack ${VERSION}`);
    return;
  }

  const dryRun = argv.includes("--dry-run");
  const emitIndex = argv.indexOf("--emit");
  const emitDir = emitIndex === -1 ? undefined : argv[emitIndex + 1];
  if (emitIndex !== -1 && !emitDir) throw new Error("--emit requires a directory");

  await ensurePackConfig();
  const config = await loadPackConfig();

  if (emitDir) {
    const plan = createDeployPlan(config);
    await emitPlan(plan, emitDir);
    console.log(`Emitted ${emitDir}`);
    return;
  }

  for (const warning of await dynamicModuleImportWarnings(config)) {
    console.warn(warning);
  }
  await build(createDeployPlan(config));
  const mode = await detectBuildOutput();
  await printBuildOutput(mode);
  const plan = createDeployPlan(config, createReleaseId(), mode);

  if (dryRun) {
    console.log(formatDryRun(plan));
    return;
  }

  await deploy(plan);
  console.log(`Deployed ${plan.releaseUrl}`);
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
