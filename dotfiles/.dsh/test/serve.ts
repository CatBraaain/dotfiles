/**
 * Serve the generated fixture on http://localhost:4173/ so browsers and
 * screenshot tools can reach them (the file: protocol is often blocked).
 * Run `bun run render.ts` first, then keep this process alive while taking
 * screenshots. `PORT=0` selects an ephemeral port for automated callers.
 */
import { join } from "node:path";

const requestedPort = Number(process.env.PORT ?? 4173);
const server = Bun.serve({
    port: requestedPort,
    fetch: () => new Response(Bun.file(join(import.meta.dir, "dist", "fixture.html"))),
});
console.log(`serving dist/fixture.html on http://localhost:${server.port}/`);
