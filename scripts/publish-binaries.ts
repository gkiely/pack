import { $ } from "bun";
import { join } from "node:path";
import { buildPackBinaries } from "./build-binaries";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "dist/binaries");
const target = "root@pack.sh";
const remoteBinDir = "/var/www/pack.sh/bin";

await buildPackBinaries(outDir);
await $`ssh ${target} mkdir -p ${remoteBinDir}`;
await $`rsync -a --delete ${outDir}/ ${target}:${remoteBinDir}/`;

console.log("published https://pack.sh/bin");
