import { lookup } from "node:dns/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixtureName = process.argv[2];

if (!fixtureName) {
  throw new Error("usage: bun scripts/smoke-language-fixture.ts <c|cpp|deno|go|rust|zig>");
}

const expected: Record<string, RegExp> = {
  c: /^hello from c\nunix:\d+\n/,
  cpp: /^hello from cpp\nunix:\d+\n/,
  deno: /^hello from deno\n/,
  go: /^hello from go\n/,
  rust: /^hello from rust\nunix:\d+\n/,
  zig: /^hello from zig\nunix:\d+\n/,
};

if (!expected[fixtureName]) throw new Error(`unknown language fixture: ${fixtureName}`);

try {
  await lookup("pack.sh");
} catch {
  throw new Error("pack.sh does not resolve through the system resolver yet");
}

const fixture = join(root, "fixtures", fixtureName);
const proc = Bun.spawn(["bun", join(root, "index.ts")], {
  cwd: fixture,
  stdout: "pipe",
  stderr: "pipe",
});

let output = "";

await Promise.all([
  (async () => {
    for await (const chunk of proc.stdout) {
      const text = Buffer.from(chunk).toString();
      output += text;
      process.stdout.write(text);
    }
  })(),
  (async () => {
    for await (const chunk of proc.stderr) {
      process.stderr.write(Buffer.from(chunk).toString());
    }
  })(),
]);

const exitCode = await proc.exited;
if (exitCode !== 0) throw new Error(`${fixtureName} deploy exited with ${exitCode}`);

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
if (!expected[fixtureName].test(body)) {
  throw new Error(`${url} returned unexpected body: ${body}`);
}

console.log(`Smoke OK ${url}`);
