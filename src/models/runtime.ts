import {
  runLegacyCodexRequest,
  testLegacyCodexConnection,
  type LegacyCodexRequest,
  type LegacyCodexResult,
} from "../codex/legacyClient";
import {
  runOpenAICompatibleRequest,
  testOpenAICompatibleConnection,
} from "./openAICompatibleClient";
import { getActiveRuntimeModel, type RuntimeModel } from "./providers";

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

export function getActiveModelSnapshot(): RuntimeModel {
  return { ...getActiveRuntimeModel() };
}

export async function runModelRequest(
  request: ModelRequest,
  model: RuntimeModel = getActiveModelSnapshot(),
  transports: ModelTransports = defaultTransports,
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
  });
}

export async function testModelConnection(
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<string> {
  if (model.authMode === "codex_auth") {
    return testLegacyCodexConnection({
      apiUrl: model.apiBase,
      model: model.model,
      effort: model.effort,
      signal,
    });
  }
  return testOpenAICompatibleConnection({
    apiBase: model.apiBase,
    apiKey: model.apiKey,
    model: model.model,
    signal,
  });
}

export function modelCacheIdentity(model: RuntimeModel): string {
  return [
    model.authMode,
    model.providerId,
    model.id,
    model.model,
    model.apiBase,
  ].join(":");
}
