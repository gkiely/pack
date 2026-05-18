import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((_, response) => {
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(`hello from node:http\n${new Date().toISOString()}\n`);
}).listen(port);
