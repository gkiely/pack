#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

int main(void) {
  int port = 3000;
  const char *port_env = getenv("PORT");
  if (port_env != NULL) {
    port = atoi(port_env);
  }

  int server_fd = socket(AF_INET, SOCK_STREAM, 0);
  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)port);

  if (bind(server_fd, (struct sockaddr *)&address, sizeof(address)) != 0) return 1;
  if (listen(server_fd, 16) != 0) return 1;

  for (;;) {
    int client_fd = accept(server_fd, NULL, NULL);
    if (client_fd < 0) continue;

    char body[128];
    int body_len = snprintf(body, sizeof(body), "hello from c\nunix:%ld\n", (long)time(NULL));
    char response[512];
    int response_len = snprintf(
      response,
      sizeof(response),
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
      body_len,
      body
    );
    write(client_fd, response, (size_t)response_len);
    close(client_fd);
  }
}
