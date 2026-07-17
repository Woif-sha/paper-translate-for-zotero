export type OpenAIProtocol = "responses" | "chat-completions";

export class OpenAIStreamParser {
  private buffer = "";
  private completed = false;

  constructor(
    private readonly protocol: OpenAIProtocol,
    private readonly onText: (delta: string) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.parseFrame(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
  }

  finish(): void {
    if (this.buffer.trim()) this.parseFrame(this.buffer);
    this.buffer = "";
    if (!this.completed) {
      throw new Error(
        `OpenAI ${this.protocol} stream ended without a completion event`,
      );
    }
  }

  private parseFrame(frame: string): void {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") {
      this.completed = true;
      return;
    }
    let event: Record<string, any>;
    try {
      event = JSON.parse(payload) as Record<string, any>;
    } catch (error) {
      throw new Error(
        `Invalid SSE JSON from OpenAI-compatible endpoint: ${String(error)}`,
      );
    }
    if (event.error) {
      throw new Error(
        `OpenAI-compatible endpoint error: ${JSON.stringify(event.error)}`,
      );
    }
    if (this.protocol === "responses") {
      if (event.type === "response.output_text.delta") {
        if (typeof event.delta !== "string")
          throw new Error("Responses delta is not text");
        this.onText(event.delta);
      }
      if (event.type === "response.completed") this.completed = true;
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        throw new Error(`Responses API ended with ${event.type}`);
      }
      return;
    }
    const choice = event.choices?.[0];
    if (!choice) throw new Error("Chat Completions stream event has no choice");
    const delta = choice.delta?.content;
    if (delta !== undefined) {
      if (typeof delta !== "string")
        throw new Error("Chat Completions delta is not text");
      this.onText(delta);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.completed = true;
    }
  }
}

export async function streamOpenAITranslation(params: {
  protocol: OpenAIProtocol;
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
  prompt: string;
  signal?: AbortSignal;
  onDelta(text: string, accumulated: string): void;
}): Promise<string> {
  if (!params.endpoint.trim()) throw new Error("API endpoint is empty");
  if (!params.apiKey.trim()) throw new Error("API key is empty");
  if (!params.model.trim()) throw new Error("API model is empty");
  let result = "";
  let processedLength = 0;
  let progressError: Error | null = null;
  const parser = new OpenAIStreamParser(params.protocol, (delta) => {
    result += delta;
    params.onDelta(delta, result);
  });
  const body =
    params.protocol === "responses"
      ? {
          model: params.model,
          input: params.prompt,
          temperature: params.temperature,
          stream: true,
        }
      : {
          model: params.model,
          messages: [{ role: "user", content: params.prompt }],
          temperature: params.temperature,
          stream: true,
        };
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request("POST", params.endpoint, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
        "api-key": params.apiKey,
      },
      body: JSON.stringify(body),
      responseType: "text",
      requestObserver: (request: XMLHttpRequest) => {
        const abort = () => request.abort();
        params.signal?.addEventListener("abort", abort, { once: true });
        request.addEventListener(
          "loadend",
          () => params.signal?.removeEventListener("abort", abort),
          {
            once: true,
          },
        );
        request.onprogress = () => {
          if (progressError) return;
          const response = request.responseText || "";
          const chunk = response.slice(processedLength);
          processedLength = response.length;
          try {
            parser.feed(chunk);
          } catch (error) {
            progressError =
              error instanceof Error ? error : new Error(String(error));
            request.abort();
          }
        };
      },
    });
  } catch (error) {
    if (progressError) throw progressError;
    if (params.signal?.aborted) throw createAbortError();
    throw error;
  }
  if (progressError) throw progressError;
  if (params.signal?.aborted) throw createAbortError();
  if (xhr.status < 200 || xhr.status >= 300) {
    throw new Error(`OpenAI-compatible request failed with HTTP ${xhr.status}`);
  }
  const remaining = String(xhr.responseText || "").slice(processedLength);
  parser.feed(remaining);
  parser.finish();
  if (!result.trim())
    throw new Error("OpenAI-compatible endpoint returned no translation");
  return result;
}

function createAbortError(): Error {
  const error = new Error("Translation aborted");
  error.name = "AbortError";
  return error;
}
