const port = Number(process.env.PORT ?? 3000);
const siteRoot = new URL("../site/", import.meta.url);
const { createBootstrapScript } = await import("./bootstrap-host");

async function killPort(port: number) {
  const result = await Bun.$`lsof -ti tcp:${port} -sTCP:LISTEN`.quiet().nothrow();
  if (result.exitCode !== 0) return;

  const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
  if (pids.length === 0) return;

  await Bun.$`kill ${pids}`.quiet().nothrow();

  for (let i = 0; i < 20; i += 1) {
    const check = await Bun.$`lsof -ti tcp:${port} -sTCP:LISTEN`.quiet().nothrow();
    if (check.exitCode !== 0 || check.stdout.toString().trim() === "") return;
    await Bun.sleep(100);
  }
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/vnd.microsoft.icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ps1": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

await killPort(port);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/server.sh") {
      return new Response(createBootstrapScript(), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    const pathname =
      url.pathname === "/" ? "/index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const file = Bun.file(new URL(`.${pathname}`, siteRoot));

    if (!(await file.exists())) return new Response("Not found", { status: 404 });

    const extension = pathname.slice(pathname.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "content-type": contentTypes[extension] ?? "application/octet-stream",
      },
    });
  },
});

console.log(`http://localhost:${port}`);
