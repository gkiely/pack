import { $ } from "bun";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const bunLinuxTarget = "bun-linux-x64-baseline";

export const packBinaryBuilds = [
  [bunLinuxTarget, "pack-linux-x64"],
  ["bun-linux-arm64", "pack-linux-arm64"],
  ["bun-darwin-x64", "pack-darwin-x64"],
  ["bun-darwin-arm64", "pack-darwin-arm64"],
  ["bun-windows-x64-baseline", "pack-windows-x64.exe"],
] as const;

export async function buildPackBinaries(outDir: string): Promise<void> {
  await $`rm -rf ${outDir}`;
  await $`mkdir -p ${outDir}`;

  for (const [targetName, outfile] of packBinaryBuilds) {
    await $`bun build ${join(root, "index.ts")} --compile --minify --target=${targetName} --outfile ${join(outDir, outfile)}`;
  }
}

if (import.meta.main) {
  const outDirArg = Bun.argv.find((arg) => arg.startsWith("--out-dir="));
  const outDir = outDirArg ? outDirArg.slice("--out-dir=".length) : join(root, "dist/binaries");
  await buildPackBinaries(outDir);
}
