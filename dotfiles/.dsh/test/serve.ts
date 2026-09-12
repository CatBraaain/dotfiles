/**
 * Serve the generated fixtures on http://localhost:4173/ so browsers and
 * screenshot tools can reach them (the file: protocol is often blocked).
 * `/` serves the light page, `/dark` the dark page. Run `bun run render.ts`
 * first, then keep this process alive while taking screenshots.
 */
import { join } from "node:path";

const port = 4173;
Bun.serve({
    port,
    fetch: (request) => {
        const dark = new URL(request.url).pathname === "/dark";
        return new Response(Bun.file(join(import.meta.dir, dark ? "fixture-dark.html" : "fixture.html")));
    },
});
console.log(`serving fixture.html on http://localhost:${port}/ and fixture-dark.html on http://localhost:${port}/dark`);
