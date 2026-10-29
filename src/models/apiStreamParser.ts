import type { LegacyCodexResult } from "../codex/legacyClient";
import type { ApiProtocol } from "./protocols";

/** Complete SSE frames are shared; completion semantics belong to each protocol. */
export class ApiStreamParser {
  private buffer = "";
  private text = "";
  private completed = false;
  private finishReason: string | undefined;

  constructor(
    private readonly protocol: ApiProtocol,
    private readonly onDelta?: (delta: string, accumulated: string) => void,
    private readonly maxOutputCharacters?: number,
  ) {}

  get isComplete(): boolean {
    return this.completed;
  }

  feed(chunk: string): void {
    if (this.completed) return;
    this.buffer += chunk;
    let match = frameBoundary(this.buffer);
    while (match) {
      this.parseFrame(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match.length);
      if (this.completed) {
        this.buffer = "";
        return;
      }
      match = frameBoundary(this.buffer);
    }
  }

  finish(): LegacyCodexResult {
    if (this.buffer.trim() && !this.completed) this.parseFrame(this.buffer);
    this.buffer = "";
    if (!this.completed) {
      throw new Error(
        this.protocol === "chat_completions"
          ? "OpenAI Compatible streaming response ended without [DONE]"
          : "API stream ended without a completion event / 响应意外中断",
      );
    }
    if (!this.text.trim())
      throw new Error(
        "API response contained no assistant text / 模型未返回正文",
      );
    return {
      text: this.text,
      usedWebSearch: false,
      webSearchCalls: 0,
      citedUrls: [],
    };
  }

  private parseFrame(frame: string): void {
    const lines = frame.split(/\r\n|\r|\n/u);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      if (this.protocol !== "chat_completions")
        throw new Error("Unexpected DONE marker for the selected protocol");
      if (!this.finishReason)
        throw new Error(
          "API response ended without a normal finish_reason / 未收到正常结束原因",
        );
      this.completed = true;
      return;
    }
    let event: Record<string, any>;
    try {
      event = JSON.parse(data) as Record<string, any>;
    } catch {
      throw new Error("Invalid API SSE JSON / 流式响应不是有效 JSON");
    }
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("Invalid API stream event");
    const type = event.type ?? eventName;
    if (event.error || type === "error") {
      throw new Error(
        `API endpoint error: ${JSON.stringify(event.error ?? event)}`,
      );
    }
    if (this.protocol === "chat_completions") {
      const choice = event.choices?.[0];
      if (choice?.delta?.tool_calls?.length || choice?.delta?.function_call)
        throw new Error("Unexpected tool call in a text response");
      if (choice?.delta?.refusal)
        throw new Error("Model refused the request / 模型拒绝了请求");
      if (choice?.finish_reason != null)
        this.acceptFinishReason(choice.finish_reason, ["stop"]);
      this.append(choice?.delta?.content);
    } else if (this.protocol === "responses") {
      if (
        type === "response.output_item.added" &&
        ["function_call", "custom_tool_call", "web_search_call"].includes(
          event.item?.type,
        )
      )
        throw new Error("Unexpected tool call in a text response");
      if (type === "response.output_text.delta") this.append(event.delta);
      if (type === "response.output_text.done" && !this.text)
        this.append(event.text);
      if (
        type === "response.refusal.delta" ||
        type === "response.refusal.done"
      ) {
        throw new Error("Model refused the request / 模型拒绝了请求");
      }
      if (type === "response.failed" || type === "response.incomplete") {
        throw new Error(
          `API response ${type}: ${JSON.stringify(event.response?.error ?? event.response?.incomplete_details ?? {})} / 响应失败或不完整`,
        );
      }
      if (type === "response.completed") {
        if (event.response?.status && event.response.status !== "completed")
          throw new Error("Response did not complete successfully");
        const output = event.response?.output ?? [];
        if (
          output.some(
            (item: any) =>
              item.type === "function_call" ||
              item.content?.some((part: any) => part.type === "refusal"),
          )
        ) {
          throw new Error("Unexpected tool call or refusal in a text response");
        }
        if (!this.text) {
          this.append(
            event.response?.output_text ??
              output
                .flatMap((item: any) => item.content ?? [])
                .filter((part: any) => part.type === "output_text")
                .map((part: any) => part.text)
                .join(""),
          );
        }
        this.completed = true;
      }
    } else {
      if (
        type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      )
        throw new Error("Unexpected tool call in a text response");
      if (
        type === "content_block_start" &&
        event.content_block?.type === "text"
      )
        this.append(event.content_block.text);
      if (type === "content_block_delta" && event.delta?.type === "text_delta")
        this.append(event.delta.text);
      if (type === "message_delta" && event.delta?.stop_reason != null)
        this.acceptFinishReason(event.delta.stop_reason, [
          "end_turn",
          "stop_sequence",
        ]);
      if (type === "message_stop") {
        if (!this.finishReason)
          throw new Error("Anthropic response ended without a stop reason");
        this.completed = true;
      }
    }
  }

  private acceptFinishReason(reason: unknown, allowed: string[]): void {
    if (typeof reason !== "string" || !allowed.includes(reason)) {
      throw new Error(
        `API response did not complete normally (${String(reason)}) / 输出被截断、过滤或未正常结束`,
      );
    }
    this.finishReason = reason;
  }

  private append(delta: unknown): void {
    if (delta === undefined || delta === null || delta === "") return;
    if (typeof delta !== "string")
      throw new Error("API output delta is not text");
    if (
      this.maxOutputCharacters &&
      this.text.length + delta.length > this.maxOutputCharacters
    ) {
      throw new Error(
        `API visible output exceeded the ${this.maxOutputCharacters}-character limit`,
      );
    }
    this.text += delta;
    this.onDelta?.(delta, this.text);
  }
}

function frameBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const endingLength = (index: number) => {
    if (value[index] === "\n") return 1;
    if (value[index] !== "\r") return 0;
    return value[index + 1] === "\n" ? 2 : 1;
  };
  for (let index = 0; index < value.length; index += 1) {
    const first = endingLength(index);
    if (!first) continue;
    const second = endingLength(index + first);
    if (second) return { index, length: first + second };
    index += first - 1;
  }
  return undefined;
}
