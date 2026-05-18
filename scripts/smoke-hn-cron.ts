import { $ } from "bun";
import { lookup } from "node:dns/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixture = join(root, "fixtures/hn-cron");
const deployHost = "pack.sh";

try {
  await lookup(deployHost);
} catch {
  throw new Error(`${deployHost} does not resolve through the system resolver yet`);
}

const output = await $`${["bun", join(root, "index.ts")]}`.cwd(fixture).text();
process.stdout.write(output);

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

const body = (await response.json()) as {
  app?: string;
  schedule?: string;
  secondsUntilNextCron?: number;
  topPost?: { title?: string };
};

if (
  body.app !== "hn-cron" ||
  body.schedule !== "*/5 * * * *" ||
  typeof body.secondsUntilNextCron !== "number" ||
  !body.topPost?.title
) {
  throw new Error(`${url} returned unexpected body: ${JSON.stringify(body)}`);
}

console.log(`Smoke OK ${url}`);
