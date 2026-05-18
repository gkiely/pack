import { $, fs } from "zx";
import { access, chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

$.verbose = false;

const require = createRequire(import.meta.url);
const seaNodeVersion = process.version;
const nodeRelease = seaNodeVersion.slice(1);
const platform = "linux-x64";
const hostPlatform = `${process.platform}-${process.arch}`;
const packDir = ".pack";
const cacheDir = join(packDir, "node");
const bundledMain = join(packDir, "index.cjs");
const appBinary = join(packDir, "app");
const seaConfigPath = join(packDir, "sea-config.json");
const seaBlobPath = join(packDir, "sea-prep.blob");
const esbuildCli = require.resolve("esbuild/bin/esbuild");
const postjectCli = require.resolve("postject/dist/cli.js");

await mkdir(cacheDir, { recursive: true });

/**
 * @param {string} version
 * @returns {{ major: number; minor: number }}
 */
function parseNodeVersion(version) {
  const [major = 0, minor = 0] = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number(part));

  return { major, minor };
}

/**
 * @param {string} version
 * @returns {boolean}
 */
function supportsBuildSea(version) {
  const { major, minor } = parseNodeVersion(version);
  return major > 25 || (major === 25 && minor >= 5);
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} target
 * @returns {string}
 */
function nodeBinaryPath(target) {
  return join(cacheDir, `node-v${nodeRelease}-${target}`, "bin/node");
}

/**
 * @param {string} target
 * @returns {Promise<string>}
 */
async function ensureNodeBinary(target) {
  const archiveName = `node-v${nodeRelease}-${target}`;
  const archiveUrl = `https://nodejs.org/dist/${seaNodeVersion}/${archiveName}.tar.xz`;
  const archivePath = join(cacheDir, `${archiveName}.tar.xz`);
  const extractDir = join(cacheDir, archiveName);
  const binaryPath = nodeBinaryPath(target);

  if (!(await exists(binaryPath))) {
    await rm(extractDir, { recursive: true, force: true });
    await $`curl -fsSL ${archiveUrl} -o ${archivePath}`;
    await $`tar -xJf ${archivePath} -C ${cacheDir}`;
  }

  return binaryPath;
}

const hostNodeBinary = await ensureNodeBinary(hostPlatform);
const targetNodeBinary = await ensureNodeBinary(platform);

await $`node ${esbuildCli} src/index.js --bundle --platform=node --format=cjs --target=node18 --tree-shaking=true --minify --legal-comments=none --outfile=${bundledMain}`;

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function seaConfig(fields) {
  return JSON.stringify(
    {
      main: bundledMain,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      ...fields,
    },
    null,
    2,
  );
}

if (supportsBuildSea(seaNodeVersion)) {
  await writeFile(
    seaConfigPath,
    seaConfig({
      executable: targetNodeBinary,
      output: appBinary,
    }),
  );
  await $`${hostNodeBinary} --build-sea ${seaConfigPath}`;
} else {
  await writeFile(
    seaConfigPath,
    seaConfig({
      output: seaBlobPath,
    }),
  );
  await $`${hostNodeBinary} --experimental-sea-config ${seaConfigPath}`;
  await copyFile(targetNodeBinary, appBinary);
  await $`node ${postjectCli} ${appBinary} NODE_SEA_BLOB ${seaBlobPath} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite`;
}

await chmod(appBinary, 0o755);
await fs.stat(appBinary);
