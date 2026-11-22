import { dlopen, ptr, toArrayBuffer } from "bun:ffi";

const ESRCH = 3;
const POLLIN = 0x001;
const POLLHUP = 0x010;
const SIGNAL_NUMBERS = { SIGTERM: 15, SIGKILL: 9 } as const;

export function openLinuxProcess(pid: number) {
  const libc = dlopen("libc.so.6", {
    pidfd_open: { args: ["i32", "u32"], returns: "i32" },
    pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  function errno(): number {
    return new Int32Array(toArrayBuffer(libc.symbols.__errno_location()!, 0, 4))[0]!;
  }

  const fd = libc.symbols.pidfd_open(pid, 0);
  if (fd < 0) {
    const code = errno();
    libc.close();
    if (code === ESRCH) return undefined;
    throw new Error("Cannot open the Linux Camoufox process (errno " + code + ")");
  }

  const pollFd = new Int32Array(2);
  const events = new Int16Array(pollFd.buffer);
  pollFd[0] = fd;
  events[2] = POLLIN;

  return {
    send(signal: keyof typeof SIGNAL_NUMBERS) {
      if (libc.symbols.pidfd_send_signal(fd, SIGNAL_NUMBERS[signal], null, 0) === 0) return;
      const code = errno();
      if (code !== ESRCH)
        throw new Error("Cannot stop the Linux Camoufox process (errno " + code + ")");
    },
    hasExited() {
      const result = libc.symbols.poll(ptr(pollFd), 1, 0);
      if (result === 0) return false;
      if (result === 1 && (events[3]! & (POLLIN | POLLHUP)) !== 0) return true;
      throw new Error("Cannot confirm that the Linux Camoufox process exited");
    },
    close() {
      libc.symbols.close(fd);
      libc.close();
    },
  };
}
