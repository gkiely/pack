import { $ } from "bun";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const generated = join(root, "generated-heavy.ts");

async function run(command: string[], label: string, iterations: number) {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    await rm(dist, { recursive: true, force: true });
    await mkdir(dist, { recursive: true });

    const started = performance.now();
    await $`${command}`.cwd(root).quiet();
    const elapsed = performance.now() - started;

    times.push(elapsed);
  }

  const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`${label}`);
  console.log(`  runs: ${times.map((time) => `${time.toFixed(1)}ms`).join(", ")}`);
  console.log(`  avg: ${avg.toFixed(1)}ms, min: ${min.toFixed(1)}ms, max: ${max.toFixed(1)}ms`);
}

async function makeHeavyFixture() {
  const chunks = Array.from({ length: 2_000 }, (_, index) => {
    return `export function fn${index}(input: number) { return input * ${index + 1} + ${index}; }`;
  });

  const calls = Array.from({ length: 2_000 }, (_, index) => `fn${index}(${index})`).join(" + ");

  await writeFile(
    generated,
    `${chunks.join("\n")}\n\nconsole.log("heavy fixture", ${calls});\n`,
  );
}

await makeHeavyFixture();

await run(["bun", "build", "./index.ts", "--compile", "--outfile", "./dist/tiny"], "tiny compile", 5);
await run(["bun", "build", "./generated-heavy.ts", "--compile", "--outfile", "./dist/heavy"], "generated-heavy compile", 5);
