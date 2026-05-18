declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
  serve(options: { hostname: string; port: number }, handler: () => Response): void;
};

const port = Number(Deno.env.get("PORT") ?? "3000");

Deno.serve({ hostname: "127.0.0.1", port }, () => {
  return new Response(`hello from deno\n${new Date().toISOString()}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
});
