#include <arpa/inet.h>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <sys/socket.h>
#include <unistd.h>

int main() {
  int port = 3000;
  if (const char *port_env = std::getenv("PORT")) {
    port = std::atoi(port_env);
  }

  int server_fd = socket(AF_INET, SOCK_STREAM, 0);
  int reuse = 1;
  setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons(static_cast<uint16_t>(port));

  if (bind(server_fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) return 1;
  if (listen(server_fd, 16) != 0) return 1;

  for (;;) {
    int client_fd = accept(server_fd, nullptr, nullptr);
    if (client_fd < 0) continue;

    std::string body = "hello from cpp\nunix:" + std::to_string(std::time(nullptr)) + "\n";
    std::string response =
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/plain; charset=utf-8\r\n"
      "Content-Length: " + std::to_string(body.size()) + "\r\n"
      "Connection: close\r\n\r\n" +
      body;

    write(client_fd, response.data(), response.size());
    close(client_fd);
  }
}
