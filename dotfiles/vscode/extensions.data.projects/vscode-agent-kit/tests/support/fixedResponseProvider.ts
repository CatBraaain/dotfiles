import { createServer } from "node:http";
import { once } from "node:events";

export const FIXTURE_PROVIDER = "fixture-local";
export const FIXTURE_MODEL = "fixture-chat";
export const FIXTURE_PROMPT = "Reply with the fixture confirmation.";
export const FIXTURE_REPLY = "Fixture assistant response confirmed.";

export interface FixedResponseProvider {
  baseUrl: string;
  requests: { model: string; stream: true }[];
  close(): Promise<void>;
}

export async function startFixedResponseProvider(): Promise<FixedResponseProvider> {
  const requests: FixedResponseProvider["requests"] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        typeof body !== "object" ||
        body === null ||
        !("model" in body) ||
        body.model !== FIXTURE_MODEL ||
        !("stream" in body) ||
        body.stream !== true ||
        !("messages" in body) ||
        !Array.isArray(body.messages)
      ) {
        response.writeHead(400).end("Invalid fixture completion request");
        return;
      }
      requests.push({ model: body.model, stream: body.stream });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const envelope = {
        id: "fixture-completion",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: FIXTURE_MODEL,
      };
      response.write(
        `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", content: FIXTURE_REPLY }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400).end("Invalid fixture completion JSON");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture provider did not bind a loopback TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
