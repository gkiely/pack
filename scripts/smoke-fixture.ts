import { $ } from "bun";
import { lookup } from "node:dns/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixture = join(root, "fixtures/bun");
const deployHost = "pack.sh";

try {
  await lookup(deployHost);
} catch {
  throw new Error(`${deployHost} does not resolve through the system resolver yet`);
}

const proc = Bun.spawn(["bun", join(root, "index.ts")], {
  cwd: fixture,
  stderr: "inherit",
});
let output = "";
const decoder = new TextDecoder();

if (!proc.stdout) throw new Error("deploy process did not expose stdout");

for await (const chunk of proc.stdout) {
  const text = decoder.decode(chunk, { stream: true });
  output += text;
  process.stdout.write(text);
}

const tail = decoder.decode();
if (tail) {
  output += tail;
  process.stdout.write(tail);
}

const exitCode = await proc.exited;
if (exitCode !== 0) throw new Error(`deploy exited with ${exitCode}`);

const match = output.match(/Deployed (https:\/\/\S+)/);
if (!match) throw new Error("deploy output did not include release URL");

const url = match[1]!;
let response: Response | undefined;
let lastError: unknown;

for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    response = await fetch(url);
    if (response.status === 200) break;
    lastError = new Error(`${url} returned ${response.status}`);
  } catch (error) {
    lastError = error;
  }
  await Bun.sleep(5000);
}

if (response?.status !== 200) throw lastError ?? new Error(`${url} did not return 200`);

const body = await response.text();
if (!/^hello from pack\n\d{4}-\d{2}-\d{2}T/.test(body)) {
  throw new Error(`${url} returned unexpected body: ${body}`);
}

console.log(`Smoke OK ${url}`);
