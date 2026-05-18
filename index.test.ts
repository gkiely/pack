import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createDeployPlan,
  detectLocalShellKind,
  DYNAMIC_MODULE_IMPORT_WARNING_PREFIX,
  DYNAMIC_MODULE_IMPORT_WARNING,
  dynamicModuleImportWarnings,
  emitPlan,
  ensurePackConfig,
  formatDryRun,
  isWslEnvironment,
  loadPackConfig,
  type PackConfig,
} from "./index";

const tempDirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pack-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.PACK_DEPLOY_HOST;
  delete process.env.PACK_HOST;
  delete process.env.PACK_RELEASE_DOMAIN;
  delete process.env.PACK_DOMAIN;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("loadPackConfig requires an explicit build command", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "hello" }));
  await mkdir(join(dir, "public"));
  await Bun.write(join(dir, "public/.keep"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await expect(loadPackConfig()).rejects.toThrow(
      "pack.json must include a build command that creates .pack/app",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig asks when project type is unclear in non-TTY mode", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "hello" }));

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await expect(ensurePackConfig()).rejects.toThrow(
      "Could not detect project type. Run pack in a TTY or create pack.json.",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Go projects", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "go.mod"), "module go-app\n\ngo 1.22\n");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("go");
    expect(config.build).toBe(
      "GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o .pack/app .",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Rust projects", async () => {
  const dir = await tempProject();
  await Bun.write(
    join(dir, "Cargo.toml"),
    '[package]\nname = "pack-rust-app"\nversion = "0.1.0"\nedition = "2021"\n',
  );

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("rust");
    expect(config.build).toBe(
      "cargo build --release --target x86_64-unknown-linux-gnu && cp target/x86_64-unknown-linux-gnu/release/pack-rust-app .pack/app",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Zig projects", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(join(dir, "src/main.zig"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("zig");
    expect(config.build).toBe(
      "zig build-exe src/main.zig -O ReleaseSmall -target x86_64-linux-gnu -lc -femit-bin=.pack/app",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects C projects", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(join(dir, "src/main.c"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("c");
    expect(config.build).toBe("zig cc src/main.c -target x86_64-linux-gnu -O2 -s -o .pack/app");
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects C++ projects", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(join(dir, "src/main.cpp"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("cpp");
    expect(config.build).toBe(
      "zig c++ src/main.cpp -target x86_64-linux-gnu -O2 -s -Wno-nullability-completeness -o .pack/app",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Deno projects", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "deno.json"), "{}");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.name).toBe(basename(dir).toLowerCase());
    expect(config.type).toBe("deno");
    expect(config.build).toBe(
      "deno compile --allow-net --allow-env --target x86_64-unknown-linux-gnu --output .pack/app src/main.ts",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Bun projects from Bun-specific signals", async () => {
  const dir = await tempProject();
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "bun-app",
      module: "src/index.ts",
      scripts: { start: "bun src/index.ts" },
    }),
  );
  await Bun.write(join(dir, "package-lock.json"), "{}");
  await Bun.write(join(dir, "bun.lock"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.type).toBe("bun");
    expect(config.build).toBe(
      "bun build ./src/index.ts --compile --minify --target=bun-linux-x64-baseline --outfile .pack/app",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("ensurePackConfig detects Node projects from Node-specific signals", async () => {
  const dir = await tempProject();
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      name: "node-app",
      scripts: { start: "node src/index.js" },
      devDependencies: { "@types/node": "latest" },
    }),
  );
  await Bun.write(join(dir, "package-lock.json"), "{}");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await ensurePackConfig();
    const config = await loadPackConfig();
    expect(config.type).toBe("node");
    expect(config.build).toBe("node build-sea.mjs");
  } finally {
    process.chdir(cwd);
  }
});

test("detectLocalShellKind treats WSL as POSIX", () => {
  expect(isWslEnvironment("linux", "6.6.87.2-microsoft-standard-WSL2", {})).toBe(true);
  expect(detectLocalShellKind("linux", "6.6.87.2-microsoft-standard-WSL2", {})).toBe("posix");
  expect(detectLocalShellKind("linux", "6.6.87", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("posix");
  expect(detectLocalShellKind("win32", "10.0.26100", {})).toBe("windows");
});

test("loadPackConfig applies defaults around an explicit build command", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "hello" }));
  await Bun.write(
    join(dir, "pack.json"),
    JSON.stringify({ build: "bun build ./src/index.ts --compile --outfile .pack/app" }),
  );
  await mkdir(join(dir, "public"));
  await Bun.write(join(dir, "public/.keep"), "");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(await loadPackConfig()).toEqual({
      name: "hello",
      type: "bun",
      entry: "src/index.ts",
      artifact: ".pack/app",
      assets: ["public"],
      build: "bun build ./src/index.ts --compile --outfile .pack/app",
    });
  } finally {
    process.chdir(cwd);
  }
});

test("loadPackConfig infers unknown type when build command is unclear", async () => {
  const dir = await tempProject();
  await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "hello" }));
  await Bun.write(join(dir, "pack.json"), JSON.stringify({ build: "make release" }));

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect((await loadPackConfig()).type).toBe("unknown");
  } finally {
    process.chdir(cwd);
  }
});

test("dynamicModuleImportWarnings warns for dynamic imports in single-file builds", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(join(dir, "src/index.ts"), "const name = 'plugin';\nawait import(`./${name}.ts`);\n");
  await Bun.write(join(dir, "src/static.ts"), "await import('./static.ts');\n");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const warnings = await dynamicModuleImportWarnings({
      name: "hello",
      type: "bun",
      entry: "src/index.ts",
      artifact: ".pack/app",
      assets: [],
      build: "bun build ./src/index.ts --compile --outfile .pack/app",
    });

    expect(warnings).toEqual([
      `${DYNAMIC_MODULE_IMPORT_WARNING_PREFIX} src/index.ts.`,
      DYNAMIC_MODULE_IMPORT_WARNING,
    ]);
  } finally {
    process.chdir(cwd);
  }
});

test("dynamicModuleImportWarnings skips static imports, non-js builds, and esbuild relative globs for node", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(
    join(dir, "src/index.ts"),
    "import './static.ts';\nconst kind = 'en';\nconst mod = require('./locale/' + kind + '.js');\n",
  );

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const baseConfig: PackConfig = {
      name: "hello",
      type: "node",
      entry: "src/index.ts",
      artifact: ".pack/app",
      assets: [],
      build: "node build-sea.mjs",
    };
    expect(await dynamicModuleImportWarnings(baseConfig)).toEqual([]);
    expect(await dynamicModuleImportWarnings({ ...baseConfig, type: "go" })).toEqual([]);
  } finally {
    process.chdir(cwd);
  }
});

test("dynamicModuleImportWarnings warns for non-relative dynamic node imports", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await Bun.write(join(dir, "src/index.ts"), "const name = 'parser';\nrequire(`pkg/${name}`);\n");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const warnings = await dynamicModuleImportWarnings({
      name: "hello",
      type: "node",
      entry: "src/index.ts",
      artifact: ".pack/app",
      assets: [],
      build: "node build-sea.mjs",
    });

    expect(warnings[0]).toBe(`${DYNAMIC_MODULE_IMPORT_WARNING_PREFIX} src/index.ts.`);
  } finally {
    process.chdir(cwd);
  }
});

test("dynamicModuleImportWarnings skips directories from gitignore", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "generated"));
  await Bun.write(join(dir, ".gitignore"), "generated\n");
  await Bun.write(join(dir, "generated/index.ts"), "await import(dynamicPath);\n");
  await Bun.write(join(dir, "src/index.ts"), "await import('./static.ts');\n");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(
      await dynamicModuleImportWarnings({
        name: "hello",
        type: "bun",
        entry: "src/index.ts",
        artifact: ".pack/app",
        assets: [],
        build: "bun build ./src/index.ts --compile --outfile .pack/app",
      }),
    ).toEqual([]);
  } finally {
    process.chdir(cwd);
  }
});

test("createDeployPlan generates systemd, metadata, and supervisor commands", () => {
  const config: PackConfig = {
    name: "hello",
    type: "bun",
    entry: "src/index.ts",
    artifact: ".pack/app",
    assets: ["public"],
    build: "bun build ./src/index.ts --compile --minify --target=bun-linux-x64-baseline --outfile .pack/app",
  };

  const plan = createDeployPlan(config, "abc1234");

  expect(plan.releaseUrl).toBe("https://abc1234.pack.sh");
  expect(plan.buildCommand).toEqual([
    "sh",
    "-lc",
    "bun build ./src/index.ts --compile --minify --target=bun-linux-x64-baseline --outfile .pack/app",
  ]);
  expect(formatDryRun(plan)).not.toContain("pack-ensure-baseline");
  expect(formatDryRun(plan)).not.toContain("/var/pack/baselines");
  expect(formatDryRun(plan)).toContain(
    "rsync -P --stats --ignore-times --no-whole-file --inplace --rsync-path",
  );
  expect(formatDryRun(plan)).toContain(".pack/app pack@pack.sh:");
  expect(formatDryRun(plan)).toContain("sftp put .pack/app pack@pack.sh:");
  expect(plan.systemdService).toContain("Description=pack release abc1234 for hello");
  expect(plan.systemdService).toContain("ExecStart=/var/pack/apps/hello/releases/abc1234/app");
  expect(plan.systemdService).toContain("EnvironmentFile=/run/pack/releases/abc1234.env");
  expect(plan.systemdService).not.toContain("Environment=PORT=41001");
  expect(formatDryRun(plan)).not.toContain("pack-allocate-port abc1234");
  expect(formatDryRun(plan)).not.toContain("pack-reload abc1234");
  expect(formatDryRun(plan)).toContain("pack-write-systemd hello abc1234");
  expect(formatDryRun(plan)).toContain(
    "curl --unix-socket /run/pack/supervisor.sock -fsS -X POST http://pack-supervisor/releases/abc1234/start",
  );
  expect(plan.metadata).toContain('"release": "abc1234"');
  expect(plan.metadata).toContain('"kind": "executable"');
  expect(plan.metadata).not.toContain("sandbox");
  expect(formatDryRun(plan)).not.toContain("trusted-token");
  expect(formatDryRun(plan)).toContain("rollback steps:");
});

test("createDeployPlan supports self-hosted deploy targets", () => {
  process.env.PACK_DEPLOY_HOST = "pack@example.com";
  process.env.PACK_RELEASE_DOMAIN = "example.com";
  const config: PackConfig = {
    name: "hello",
    type: "bun",
    entry: "src/index.ts",
    artifact: ".pack/app",
    assets: [],
    build: "bun build ./src/index.ts --compile --outfile .pack/app",
  };

  const plan = createDeployPlan(config, "abc1234");

  expect(plan.releaseUrl).toBe("https://abc1234.example.com");
  expect(formatDryRun(plan)).toContain(".pack/app pack@example.com:");
  expect(formatDryRun(plan)).toContain("ssh pack@example.com");
});

test("emitPlan writes deploy artifacts", async () => {
  const dir = await tempProject();
  const config: PackConfig = {
    name: "hello",
    type: "bun",
    entry: "src/index.ts",
    artifact: ".pack/app",
    assets: [],
    build: "bun build ./src/index.ts --compile --outfile .pack/app",
  };

  await emitPlan(createDeployPlan(config, "abc1234"), join(dir, ".pack/emit"));

  expect(await Bun.file(join(dir, ".pack/emit/systemd/pack-abc1234.service")).text()).toContain(
    "MemoryMax=256M",
  );
  expect(await Bun.file(join(dir, ".pack/emit/metadata.json")).text()).toContain(
    '"release": "abc1234"',
  );
  expect(await Bun.file(join(dir, ".pack/emit/remote-commands.sh")).text()).toContain(
    "pack-write-systemd hello abc1234",
  );
  expect(await Bun.file(join(dir, ".pack/emit/remote-commands.sh")).text()).toContain(
    "http://pack-supervisor/releases/abc1234/start",
  );
  expect(await Bun.file(join(dir, ".pack/emit/remote-commands.sh")).text()).not.toContain(
    "pack-write-root-caddy",
  );
});
