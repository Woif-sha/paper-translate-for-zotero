import {
  flattenRuntimeModels,
  validateProviderConfiguration,
  type ModelProviderConfiguration,
  type ModelProviderGroup,
  type RuntimeModel,
} from "./providers";

export type ModelSelectionDependencies = {
  getConfiguration(): ModelProviderConfiguration;
  setActiveModelId(modelId: string): RuntimeModel;
  setConfiguration(
    providers: ModelProviderGroup[],
    activeModelId: string,
  ): ModelProviderConfiguration;
  cancelModelTasks(): void;
};

export type ModelSelectionActions = {
  switchActiveModel(modelId: string): RuntimeModel;
  saveModelProviderConfiguration(
    providers: ModelProviderGroup[],
    activeModelId: string,
  ): ModelProviderConfiguration;
};

export function createModelSelectionActions(
  dependencies: ModelSelectionDependencies,
): ModelSelectionActions {
  return {
    switchActiveModel: (modelId) => selectActiveModel(modelId, dependencies),
    saveModelProviderConfiguration: (providers, activeModelId) =>
      saveProviderConfiguration(providers, activeModelId, dependencies),
  };
}

export function selectActiveModel(
  modelId: string,
  dependencies: ModelSelectionDependencies,
): RuntimeModel {
  const current = dependencies.getConfiguration();
  const selected = requireRuntimeModel(current, modelId);
  if (current.activeModelId === modelId) return selected;
  dependencies.cancelModelTasks();
  return dependencies.setActiveModelId(modelId);
}

export function saveProviderConfiguration(
  providers: ModelProviderGroup[],
  activeModelId: string,
  dependencies: ModelSelectionDependencies,
): ModelProviderConfiguration {
  const current = dependencies.getConfiguration();
  const validated = validateProviderConfiguration(providers, activeModelId);
  const previousActive = requireRuntimeModel(current, current.activeModelId);
  const nextActive = requireRuntimeModel(validated, validated.activeModelId);
  if (
    runtimeConfigurationKey(previousActive) !==
    runtimeConfigurationKey(nextActive)
  ) {
    dependencies.cancelModelTasks();
  }
  return dependencies.setConfiguration(
    validated.providers,
    validated.activeModelId,
  );
}

function requireRuntimeModel(
  configuration: ModelProviderConfiguration,
  modelId: string,
): RuntimeModel {
  const selected = flattenRuntimeModels(configuration.providers, modelId).find(
    (model) => model.id === modelId,
  );
  if (!selected) throw new Error(`当前模型不存在：${modelId}`);
  return selected;
}

function runtimeConfigurationKey(model: RuntimeModel): string {
  return JSON.stringify({
    id: model.id,
    providerId: model.providerId,
    authMode: model.authMode,
    apiBase: model.apiBase,
    apiKey: model.apiKey,
    model: model.model,
    effort: model.effort,
  });
}
