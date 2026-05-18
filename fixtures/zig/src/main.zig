const std = @import("std");
const linux = std.os.linux;

fn check(rc: usize) !usize {
    if (linux.errno(rc) != .SUCCESS) return error.SyscallFailed;
    return rc;
}

pub fn main() !void {
    const port_text = if (std.c.getenv("PORT")) |value| std.mem.span(value) else "3000";
    const port = try std.fmt.parseInt(u16, port_text, 10);

    const socket_rc = try check(linux.socket(linux.AF.INET, linux.SOCK.STREAM, 0));
    const server_fd: i32 = @intCast(socket_rc);
    defer _ = linux.close(server_fd);

    const yes: i32 = 1;
    _ = linux.setsockopt(
        server_fd,
        linux.SOL.SOCKET,
        linux.SO.REUSEADDR,
        @ptrCast(&yes),
        @sizeOf(i32),
    );

    var address = linux.sockaddr.in{
        .port = std.mem.nativeToBig(u16, port),
        .addr = 0,
    };
    _ = try check(linux.bind(
        server_fd,
        @ptrCast(&address),
        @sizeOf(linux.sockaddr.in),
    ));
    _ = try check(linux.listen(server_fd, 128));

    while (true) {
        const client_rc = try check(linux.accept(server_fd, null, null));
        const client_fd: i32 = @intCast(client_rc);
        defer _ = linux.close(client_fd);

        var request_buffer: [1024]u8 = undefined;
        _ = linux.read(client_fd, &request_buffer, request_buffer.len);

        var time: linux.timespec = undefined;
        _ = try check(linux.clock_gettime(.REALTIME, &time));
        const now = time.sec;
        var body: [128]u8 = undefined;
        const body_text = try std.fmt.bufPrint(&body, "hello from zig\nunix:{d}\n", .{now});
        var response: [512]u8 = undefined;
        const response_text = try std.fmt.bufPrint(
            &response,
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n{s}",
            .{ body_text.len, body_text },
        );
        _ = try check(linux.write(client_fd, response_text.ptr, response_text.len));
    }
}
