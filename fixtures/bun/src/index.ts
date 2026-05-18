const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch() {
    return new Response(`hello from pack\n${new Date().toISOString()}\n`);
  },
});
