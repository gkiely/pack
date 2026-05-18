import { $ } from 'bun';
import { existsSync, watch } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const watchedPaths = ["index.ts", "package.json", "tsconfig.json"];
const debounceMs = 100;

let timer: Timer | undefined;
let running = false;
let pending = false;

async function pack() {
  if (running) {
    pending = true;
    return;
  }

  running = true;
  pending = false;

  const started = performance.now();
  console.log("packing...");

  const result = await $`bun run compile:mac`.nothrow();

  if (result.exitCode === 0) {
    console.log(`packed in ${(performance.now() - started).toFixed(0)}ms`);
  } else {
    console.error(`pack failed with exit code ${result.exitCode}`);
  }

  running = false;

  if (pending) {
    void pack();
  }
}

function schedulePack() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void pack(), debounceMs);
}

const watchers = watchedPaths
  .map((path) => join(root, path))
  .filter((path) => existsSync(path))
  .map((path) => watch(path, schedulePack));

process.on("SIGINT", () => {
  for (const watcher of watchers) {
    watcher.close();
  }
  process.exit(0);
});

await pack();
console.log("watching for changes...");
