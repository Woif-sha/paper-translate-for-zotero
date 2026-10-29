import {
  CodexLoginRequiredError,
  runLegacyCodexRequest,
  type LegacyCodexRequest,
  type LegacyCodexResult,
} from "../codex/legacyClient";
import { runOpenAICompatibleRequest } from "./openAICompatibleClient";
import { getActiveRuntimeModel, type RuntimeModel } from "./providers";
import { normalizeApiSettings } from "./protocols";
import { withRequestDeadline } from "./requestLifetime";

export type { RuntimeModel } from "./providers";

export type ModelRequest = Omit<
  LegacyCodexRequest,
  "apiUrl" | "model" | "effort"
>;

export type ModelTransports = {
  codex(request: LegacyCodexRequest): Promise<LegacyCodexResult>;
  openAICompatible(
    request: Parameters<typeof runOpenAICompatibleRequest>[0],
  ): Promise<LegacyCodexResult>;
};

const defaultTransports: ModelTransports = {
  codex: runLegacyCodexRequest,
  openAICompatible: runOpenAICompatibleRequest,
};

export function modelErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}: ${Array.from(error.errors, modelErrorMessage).join("; ")}`;
  }
  return error instanceof CodexLoginRequiredError
    ? error.message
    : String(error);
}

export function getActiveModelSnapshot(): RuntimeModel {
  return { ...getActiveRuntimeModel() };
}

export async function runModelRequest(
  request: ModelRequest,
  model: RuntimeModel = getActiveModelSnapshot(),
  transports: ModelTransports = defaultTransports,
): Promise<LegacyCodexResult> {
  const settings = normalizeApiSettings(model);
  return withRequestDeadline(
    (signal) =>
      dispatchModelRequest(
        {
          ...request,
          signal,
          onDelta: request.onDelta
            ? (delta, accumulated) => {
                if (!signal.aborted) request.onDelta?.(delta, accumulated);
              }
            : undefined,
        },
        model,
        transports,
      ),
    settings.timeoutSeconds * 1000,
    request.signal,
  );
}

async function dispatchModelRequest(
  request: ModelRequest,
  model: RuntimeModel,
  transports: ModelTransports,
): Promise<LegacyCodexResult> {
  if (model.authMode === "codex_auth") {
    return transports.codex({
      ...request,
      apiUrl: model.apiBase,
      model: model.model,
      effort: model.effort,
    });
  }
  return transports.openAICompatible({
    ...request,
    apiBase: model.apiBase,
    apiKey: model.apiKey,
    model: model.model,
    ...normalizeApiSettings(model),
  });
}

export async function testModelConnection(
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runModelRequest(
    {
      instructions: "Reply with exactly OK.",
      prompt: "Say OK",
      signal,
      maxOutputCharacters: 128,
      maxResponseBytes: 64_000,
    },
    { ...model, timeoutSeconds: 30 },
  );
  if (result.text.trim() !== "OK")
    throw new Error(
      "Text test returned an unexpected reply / 文本测试返回内容不符合预期",
    );
  return result.text.trim();
}

export function modelCacheIdentity(model: RuntimeModel): string {
  return [
    model.authMode,
    model.providerId,
    model.id,
    model.model,
    model.apiBase,
    model.protocol ?? "chat_completions",
    model.workspaceId ?? "",
    model.anthropicVersion ?? "",
  ].join(":");
}
