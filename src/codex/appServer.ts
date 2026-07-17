type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (params: unknown) => void;

type SubprocessLike = {
  stdin: { write(value: string): void };
  stdout: { readString(): Promise<string> };
  stderr?: { readString(): Promise<string> };
  kill(): void;
  wait?(): Promise<unknown>;
};

export type CodexTurnOptions = {
  threadId: string;
  prompt: string;
  model: string;
  effort?: string;
  cwd?: string;
  signal?: AbortSignal;
  onDelta?: (text: string, accumulated: string) => void;
  requireWebSearch?: boolean;
};

export type CodexTurnResult = {
  text: string;
  usedWebSearch: boolean;
};

const REQUEST_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 300_000;

export class CodexAppServerClient {
  private nextId = 1;
  private lineBuffer = "";
  private pending = new Map<number, PendingRequest>();
  private notifications = new Map<string, Set<NotificationHandler>>();
  private closed = false;
  private readLoop: Promise<void> | null = null;

  private constructor(private readonly process: SubprocessLike) {}

  static forTest(process: SubprocessLike): CodexAppServerClient {
    return new CodexAppServerClient(process);
  }

  static async spawn(codexPath?: string): Promise<CodexAppServerClient> {
    const Subprocess = await loadSubprocessModule();
    const invocation = resolveCodexInvocation(codexPath);
    const process = (await Subprocess.call({
      command: invocation.command,
      arguments: invocation.arguments,
      stderr: "pipe",
    })) as SubprocessLike;
    const client = new CodexAppServerClient(process);
    client.startReadLoop();
    await client.sendRequest("initialize", {
      clientInfo: {
        name: "paper_translate_for_zotero",
        title: "Paper Translate for Zotero",
        version: "0.1.0",
      },
    });
    client.sendNotification("initialized", {});
    return client;
  }

  async startThread(params: {
    model: string;
    developerInstructions: string;
    cwd?: string;
    webSearch: "disabled" | "cached" | "live";
  }): Promise<string> {
    const result = await this.sendRequest("thread/start", {
      model: params.model,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "paper_translate_for_zotero",
      developerInstructions: params.developerInstructions,
      config: { web_search: params.webSearch },
      ...(params.cwd ? { cwd: params.cwd } : {}),
    });
    const threadId = extractId(result, "thread");
    if (!threadId)
      throw new Error("Codex app-server did not return a thread ID");
    return threadId;
  }

  async runTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
    if (options.signal?.aborted) throw createAbortError();
    let accumulated = "";
    let usedWebSearch = false;
    let turnId = "";
    let failBeforeStart: (error: unknown) => void = () => undefined;
    const completion = new Promise<CodexTurnResult>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("Timed out waiting for Codex turn")));
      }, TURN_TIMEOUT_MS);
      const unsubscribers: Array<() => void> = [];
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        unsubscribers.forEach((unsubscribe) => unsubscribe());
        finish();
      };
      const onAbort = () => {
        if (turnId) {
          void this.sendRequest(
            "turn/interrupt",
            { threadId: options.threadId, turnId },
            5_000,
          ).catch((error) => {
            ztoolkit.log("Codex turn interrupt failed", error);
          });
        }
        settle(() => reject(createAbortError()));
      };
      failBeforeStart = (error) => settle(() => reject(error));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      unsubscribers.push(
        this.onNotification("item/agentMessage/delta", (raw) => {
          const event = raw as {
            turnId?: string;
            turn?: { id?: string };
            delta?: string;
          };
          const eventTurnId = event.turn?.id || event.turnId;
          if (turnId && eventTurnId && eventTurnId !== turnId) return;
          if (typeof event.delta !== "string") return;
          accumulated += event.delta;
          options.onDelta?.(event.delta, accumulated);
        }),
        this.onNotification("item/started", (raw) => {
          const event = raw as { turnId?: string; item?: { type?: string } };
          if (turnId && event.turnId && event.turnId !== turnId) return;
          if (event.item?.type === "webSearch") usedWebSearch = true;
        }),
        this.onNotification("turn/completed", (raw) => {
          const event = raw as {
            turnId?: string;
            turn?: { id?: string; status?: string };
            status?: string;
          };
          const completedTurnId = event.turn?.id || event.turnId;
          if (!turnId || completedTurnId !== turnId) return;
          const status = event.turn?.status || event.status;
          if (status !== "completed") {
            settle(() =>
              reject(new Error(`Codex turn ended with status: ${status}`)),
            );
            return;
          }
          if (options.requireWebSearch && !usedWebSearch) {
            settle(() =>
              reject(
                new Error(
                  "Codex background research completed without using web search",
                ),
              ),
            );
            return;
          }
          if (!accumulated.trim()) {
            settle(() =>
              reject(
                new Error("Codex turn completed without an agent message"),
              ),
            );
            return;
          }
          settle(() => resolve({ text: accumulated, usedWebSearch }));
        }),
      );
    });

    let turnResult: unknown;
    try {
      turnResult = await this.sendRequest("turn/start", {
        threadId: options.threadId,
        input: [{ type: "text", text: options.prompt }],
        model: options.model,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.effort
          ? { effort: options.effort, summary: "detailed" }
          : {}),
      });
    } catch (error) {
      failBeforeStart(error);
      return completion;
    }
    turnId = extractId(turnResult, "turn");
    if (!turnId) throw new Error("Codex app-server did not return a turn ID");
    return completion;
  }

  sendRequest(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notifications.get(method) ?? new Set();
    handlers.add(handler);
    this.notifications.set(method, handlers);
    return () => handlers.delete(handler);
  }

  handleLineForTest(line: string): void {
    this.handleLine(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.kill();
    await this.process.wait?.();
    this.rejectAll(new Error("Codex app-server closed"));
  }

  private startReadLoop(): void {
    this.readLoop = (async () => {
      try {
        while (!this.closed) {
          const chunk = await this.process.stdout.readString();
          if (!chunk) break;
          this.lineBuffer += chunk;
          const lines = this.lineBuffer.split("\n");
          this.lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) this.handleLine(line);
          }
        }
      } catch (error) {
        if (!this.closed)
          this.rejectAll(
            error instanceof Error ? error : new Error(String(error)),
          );
      }
      if (!this.closed) {
        this.closed = true;
        this.rejectAll(new Error("Codex app-server exited unexpectedly"));
      }
    })();
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid JSON from Codex app-server: ${String(error)}`);
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(`Codex app-server error: ${JSON.stringify(message.error)}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.notifications.get(message.method) ?? []) {
        handler(message.params);
      }
    }
  }

  private sendNotification(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let sharedClient: Promise<CodexAppServerClient> | null = null;

export function getCodexClient(codexPath?: string) {
  if (!sharedClient) sharedClient = CodexAppServerClient.spawn(codexPath);
  return sharedClient;
}

export async function closeCodexClient(): Promise<void> {
  const active = sharedClient;
  sharedClient = null;
  if (active) await (await active).close();
}

function extractId(result: unknown, key: "thread" | "turn"): string {
  if (!result || typeof result !== "object") return "";
  const value = result as {
    id?: unknown;
    thread?: { id?: unknown };
    turn?: { id?: unknown };
  };
  if (typeof value.id === "string") return value.id;
  const nested = value[key];
  return typeof nested?.id === "string" ? nested.id : "";
}

async function loadSubprocessModule(): Promise<{
  call(options: unknown): Promise<unknown>;
}> {
  const chromeUtils = (globalThis as unknown as { ChromeUtils?: any })
    .ChromeUtils;
  const module = chromeUtils?.importESModule?.(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  const Subprocess = module?.Subprocess || module?.default || module;
  if (!Subprocess?.call) {
    throw new Error("Subprocess module is unavailable in this Zotero runtime");
  }
  return Subprocess;
}

function resolveCodexInvocation(codexPath?: string): {
  command: string;
  arguments: string[];
} {
  const binary = (codexPath || resolveDefaultCodexPath()).trim();
  if (!binary) throw new Error("Codex CLI path is not configured");
  if (/["&|<>^\r\n]/.test(binary)) {
    throw new Error("Codex CLI path contains unsupported shell characters");
  }
  if (Zotero.isWin) {
    const systemRoot = Services.env.get("SystemRoot") || "C:\\Windows";
    return {
      command: `${systemRoot}\\System32\\cmd.exe`,
      arguments: ["/d", "/s", "/c", `"${binary}" app-server`],
    };
  }
  return { command: binary, arguments: ["app-server"] };
}

function resolveDefaultCodexPath(): string {
  if (!Zotero.isWin) return "codex";
  const appData = Services.env.get("APPDATA");
  return appData ? `${appData}\\npm\\codex.cmd` : "codex";
}

function createAbortError(): Error {
  const error = new Error("Translation aborted");
  error.name = "AbortError";
  return error;
}
