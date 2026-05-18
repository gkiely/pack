const port = Number(process.env.PORT ?? 3000);
const schedule = "*/5 * * * *";

type TopPost = {
  id: number;
  title: string;
  url: string;
};

let topPost: TopPost | undefined;
let lastFetchedAt: string | undefined;
let lastError: string | undefined;
let fetchCount = 0;

async function fetchTopPost() {
  try {
    const ids = (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then((r) =>
      r.json(),
    )) as number[];
    const id = ids[0];
    const item = (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) =>
      r.json(),
    )) as { id: number; title?: string; url?: string };

    topPost = {
      id: item.id,
      title: item.title ?? "(untitled)",
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
    };
    lastFetchedAt = new Date().toISOString();
    lastError = undefined;
    fetchCount += 1;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

function nextCron() {
  const next = Bun.cron.parse(schedule);
  const now = Date.now();
  return {
    at: next?.toISOString() ?? null,
    inSeconds: next ? Math.max(0, Math.ceil((next.getTime() - now) / 1000)) : null,
  };
}

Bun.cron(schedule, fetchTopPost);
await fetchTopPost();

Bun.serve({
  port,
  async fetch() {
    const next = nextCron();
    return Response.json({
      app: "hn-cron",
      schedule,
      serverTime: new Date().toISOString(),
      lastFetchedAt,
      fetchCount,
      nextCronAt: next.at,
      secondsUntilNextCron: next.inSeconds,
      topPost,
      lastError,
    });
  },
});
