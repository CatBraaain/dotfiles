import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { INITIAL_REQUEST_DIRECTORY } from "./initial-request-files";
import { sessionName } from "./pane-inventory";

const realTmux = Bun.which("tmux");
const node = Bun.which("node");
const bwrap = Bun.which("bwrap");
const pidNamespaceArgs = [
  "--unshare-pid",
  "--ro-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
];
const canIsolatePid =
  process.platform === "linux" &&
  bwrap !== null &&
  Bun.spawnSync([bwrap, ...pidNamespaceArgs, "--", "/bin/true"]).exitCode === 0;
const cli = join(import.meta.dir, "main.ts");
const longRequest = `-long-body-sentinel "double" ‘curly’\r\n${"a'".repeat(12_000)}`.slice(
  0,
  24_000,
);
const shortRequest = `-short "quote" 'single'\r\nsecond line`;

const fakePi = String.raw`
const { execFileSync } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const argv = process.argv.slice(2);
const id = argv[1];
const cwd = process.cwd();
const file = join(process.env.PI_CODING_AGENT_SESSION_DIR, id + '.jsonl');
const capture = join(process.env.PI_CODING_AGENT_SESSION_DIR, id + '.argv');
appendFileSync(capture, JSON.stringify({ argv, cwd, pid: process.pid, tty: process.stdin.isTTY, stale: process.env.PI_MUX_TEST_STALE, empty: process.env.PI_MUX_TEST_EMPTY }) + '\n');
if (!process.env.TMUX) process.exit(0);
const socket = process.env.TMUX.split(',')[0];
const metadata = Buffer.from(JSON.stringify({ id, file, cwd, pid: process.pid, processPid: process.pid, startup: 'ready', token: process.env.PI_TMUX_LAUNCH_TOKEN })).toString('base64');
writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }) + '\n');
process.on('SIGINT', () => writeFileSync(capture + '.sigint', String(process.pid)));
process.on('SIGWINCH', () => writeFileSync(capture + '.resize', String(process.stdout.columns)));
execFileSync(process.env.PI_MUX_TEST_TMUX, ['-S', socket, 'set-option', '-p', '-t', process.env.TMUX_PANE, '@pi-tmux-session', metadata]);
setInterval(() => {}, 1000);
`;

async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) {
      const value = readFileSync(file, "utf8");
      if (value.length > 0) return value;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

for (const scenario of ["fresh server", "existing server", "isolated client"] as const) {
  const existing = scenario !== "fresh server";
  const isolated = scenario === "isolated client";
  test.skipIf(process.platform !== "linux" || !realTmux || !node || (isolated && !canIsolatePid))(
    `public new preserves direct argv (${scenario})`,
    async () => {
      assert.ok(realTmux && node);
      const projects = "/tmp/work/dotfiles";
      mkdirSync(projects, { recursive: true });
      const root = mkdtempSync(join(projects, "mux-argv-"));
      const cwd = join(root, "workspace with spaces");
      const runtime = join(root, "runtime");
      const socket = join(runtime, "pi-tmux/server.sock");
      const home = join(root, "home");
      const agent = join(root, "agent");
      const conf = join(home, ".config/tmux/pi.conf");
      const sessions = join(agent, "sessions");
      const extension = join(agent, "extensions/pi-mux-bridge/index.ts");
      const pi = join(root, "bin/pi");
      const env = {
        HOME: home,
        BASH_ENV: join(root, "bash-env"),
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        XDG_RUNTIME_DIR: runtime,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        PI_MUX_TEST_TMUX: realTmux,
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
      };
      const tmux = (...args: string[]) => {
        const result = Bun.spawnSync([realTmux, "-S", socket, "-f", conf, ...args], { env });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        return result.stdout.toString();
      };
      try {
        for (const dir of [
          cwd,
          join(runtime, "pi-tmux"),
          `${home}/.config/tmux`,
          sessions,
          `${agent}/extensions/pi-mux-bridge`,
          `${root}/bin`,
        ])
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(conf, "set -g exit-empty off\nset -g default-shell /bin/bash\n");
        writeFileSync(env.BASH_ENV, "export PI_MUX_TEST_EMPTY=\n");
        writeFileSync(extension, "export default () => {};\n");
        writeFileSync(pi, `#!${node}\n${fakePi}`, { mode: 0o700 });
        writeFileSync(
          join(root, "bin/tmux"),
          `#!/bin/sh
if [ "$PI_MUX_TEST_REJECT_LAUNCH" = 1 ]; then
  for argument in "$@"; do
    case "$argument" in
      exec*"claim-initial-request"*) echo "fixture refused pane creation" >&2; exit 1 ;;
    esac
  done
fi
exec ${JSON.stringify(realTmux)} "$@"
`,
          { mode: 0o700 },
        );
        let invocation = [process.execPath, cli];
        if (existing) {
          const binary = join(root, "bin", "pi-mux");
          const compiled = Bun.spawnSync([
            process.execPath,
            "build",
            "--compile",
            cli,
            "--outfile",
            binary,
          ]);
          assert.equal(compiled.exitCode, 0, compiled.stderr.toString());
          invocation = [binary];
          tmux("new-session", "-d", "-s", "seed", "sleep", "180");
          tmux("set-environment", "-g", "PI_MUX_TEST_STALE", "do not inherit");
        }
        if (isolated) {
          assert.ok(bwrap);
          const sandbox = [bwrap, ...pidNamespaceArgs, "--bind", root, root, "--"];
          const serverPid = tmux("display-message", "-p", "#{pid}").trim();
          assert.match(serverPid, /^[1-9]\d*$/);
          const visibility = Bun.spawnSync([
            ...sandbox,
            "/bin/test",
            "!",
            "-e",
            `/proc/${serverPid}`,
          ]);
          assert.equal(
            visibility.exitCode,
            0,
            "the tmux server must be outside the client namespace",
          );
          invocation = [...sandbox, ...invocation];
        }
        for (const request of isolated ? [shortRequest] : [longRequest, shortRequest]) {
          const result = Bun.spawnSync([...invocation, "new", "--detached", request], {
            cwd,
            env,
            timeout: 6_000,
          });
          assert.equal(result.exitCode, 0, result.stderr.toString());
          const id = /^Pi session ([a-f0-9-]+)$/m.exec(result.stdout.toString())?.[1];
          assert.ok(id);
          const capture = join(sessions, `${id}.argv`);
          const target = `=${sessionName(id)}`;
          const [pane, pid, startCommand] = tmux(
            "list-panes",
            "-t",
            target,
            "-F",
            "#{pane_id}\t#{pane_pid}\t#{pane_start_command}",
          )
            .trimEnd()
            .split("\t");
          const direct = Bun.spawnSync(
            [pi, "--session-id", `${id}-direct`, "-e", extension, "--agent", "main", "--", request],
            { cwd, env },
          );
          assert.equal(direct.exitCode, 0, direct.stderr.toString());
          const directArgv = JSON.parse(
            readFileSync(join(sessions, `${id}-direct.argv`), "utf8"),
          ).argv;
          directArgv[1] = id;
          const captured = readFileSync(capture, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(captured.length, 1);
          assert.ok(captured[0].argv.every((arg: string, i: number) => arg === directArgv[i]));
          assert.equal(captured[0].argv.length, directArgv.length);
          assert.equal(captured[0].cwd, cwd);
          assert.equal(captured[0].pid, Number(pid));
          assert.equal(captured[0].tty, true);
          assert.equal(captured[0].stale, undefined);
          assert.equal(captured[0].empty, "");
          assert.deepEqual(readdirSync(join(runtime, "pi-tmux", INITIAL_REQUEST_DIRECTORY)), []);
          assert.ok(pane && startCommand && !startCommand.includes(request.slice(0, 12)));
          assert.ok(!tmux("show-environment", "-t", target).includes(request.slice(0, 12)));
          tmux("send-keys", "-t", pane, "C-c");
          assert.equal(await waitForFile(`${capture}.sigint`), pid);
          tmux("resize-window", "-t", pane, "-x", "91", "-y", "31");
          assert.equal(await waitForFile(`${capture}.resize`), "91");
        }
        if (scenario === "existing server") {
          const before = readdirSync(sessions);
          const rejected = Bun.spawnSync(
            [...invocation, "new", "--detached", "body must not start"],
            {
              cwd,
              env: { ...env, PI_MUX_TEST_REJECT_LAUNCH: "1" },
              timeout: 6_000,
            },
          );
          assert.equal(rejected.exitCode, 1);
          assert.match(
            rejected.stderr.toString(),
            /Cannot start pi session: fixture refused pane creation/,
          );
          assert.deepEqual(readdirSync(sessions), before);
          assert.deepEqual(readdirSync(join(runtime, "pi-tmux", INITIAL_REQUEST_DIRECTORY)), []);
        }
      } finally {
        Bun.spawnSync([realTmux, "-S", socket, "kill-server"], { env });
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
}
