import { config, homepage } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  createProviderGroup,
  createProviderModel,
  getModelProviderConfiguration,
  resolveDraftRuntimeModel,
  subscribeModelConfiguration,
  type ModelAuthMode,
  type ModelProviderGroup,
  type ProviderModel,
} from "../models/providers";
import { modelErrorMessage, testModelConnection } from "../models/runtime";
import type { ModelSelectionActions } from "../models/selection";
import {
  API_PROTOCOLS,
  PROVIDER_PRESETS,
  endpointPreview,
  resolveApiEndpoint,
  type ApiProtocol,
} from "../models/protocols";
import { testModelImageConnection } from "../models/connectionTests";
import { fetchProviderModels } from "../models/modelDiscovery";
import { openModelPicker } from "./modelPicker";
import { ProviderEditorDraft } from "../models/providerEditorDraft";

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;
let preferencesRegistered = false;
const connectionTestControllers = new Set<AbortController>();
const discoveryControllers = new Map<HTMLElement, AbortController>();
const modelPickers = new Map<HTMLElement, () => void>();
const preferenceEditors = new Map<
  Window,
  { root: HTMLElement; dispose(): void }
>();

export async function registerPrefsWindow(): Promise<void> {
  if (preferencesRegistered) return;
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREFERENCES_PANE_ID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/section-20.png`,
    helpURL: homepage,
  });
  preferencesRegistered = true;
}

export function unregisterPrefsWindow(): void {
  for (const editor of preferenceEditors.values()) editor.dispose();
  cancelConnectionTests();
  stopModelDiscovery();
  if (!preferencesRegistered) return;
  Zotero.PreferencePanes.unregister(PREFERENCES_PANE_ID);
  preferencesRegistered = false;
}

export function registerPrefsScripts(
  window: Window,
  modelSelection: ModelSelectionActions,
): void {
  addon.data.prefs.window = window;
  const doc = window.document;
  const root = requiredElement<HTMLElement>(
    doc,
    `zotero-prefpane-${config.addonRef}`,
  );
  const previousEditor = preferenceEditors.get(window);
  if (previousEditor?.root === root) return;
  previousEditor?.dispose();
  const memory = new ProviderEditorDraft(
    getModelProviderConfiguration().providers,
  );
  let drafts = memory.providers;
  const openProviderIds = memory.openProviderIds;
  const openModelIds = memory.openModelIds;
  const remember = () => {
    memory.providers = drafts;
    memory.remember();
  };
  bindSourceLanguage(doc);
  bindPreferenceTabs(doc, memory.tab, (tab) => {
    memory.tab = tab;
    remember();
  });
  ensureProviderStyles(doc);

  const render = () => {
    cancelConnectionTests();
    stopModelDiscovery();
    const configuration = getModelProviderConfiguration();
    renderProviderCards({
      doc,
      drafts,
      openProviderIds,
      openModelIds,
      memory,
      activeModelId: configuration.activeModelId,
      modelSelection,
      onDraftsChanged(next) {
        drafts = next;
        render();
      },
      onSaved(saved, savedProviderId) {
        memory.acceptSaved(saved);
        drafts = memory.providers;
        render();
        if (!savedProviderId) return;
        const savedCard = Array.from(doc.querySelectorAll("section"))
          .map((entry) => entry as unknown as HTMLElement)
          .find((entry) => entry.dataset.providerId === savedProviderId);
        if (savedCard) {
          showCardStatus(savedCard, getString("pref-provider-saved"), false);
        }
      },
    });
    remember();
  };

  const add = requiredElement<HTMLButtonElement>(
    doc,
    `${config.addonRef}-add-provider`,
  );
  add.classList.add("pt-provider-add");
  const addProvider = () => {
    const provider = createProviderGroup("openai_compatible");
    provider.name = nextProviderName(drafts);
    provider.models.push(createProviderModel());
    drafts = [...drafts, provider];
    openProviderIds.add(provider.id);
    render();
  };
  add.addEventListener("click", addProvider);
  // Target handlers update fields before bubbling reaches the editor root.
  root.addEventListener("input", remember);
  root.addEventListener("change", remember);
  root.addEventListener("click", remember);
  const unsubscribe = subscribeModelConfiguration(render);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    remember();
    unsubscribe();
    root.removeEventListener("input", remember);
    root.removeEventListener("change", remember);
    root.removeEventListener("click", remember);
    add.removeEventListener("click", addProvider);
    window.removeEventListener("unload", dispose);
    preferenceEditors.delete(window);
    cancelConnectionTests();
    stopModelDiscovery();
  };
  preferenceEditors.set(window, { root, dispose });
  window.addEventListener("unload", dispose, { once: true });
  render();
  if (memory.invalidCache) {
    const card = doc.querySelector(".pt-provider-card") as HTMLElement | null;
    if (card)
      showCardStatus(card, getString("pref-provider-draft-invalid"), true);
  }
}

type ProviderCardRenderParams = {
  doc: Document;
  drafts: ModelProviderGroup[];
  activeModelId: string;
  openProviderIds: Set<string>;
  openModelIds: Set<string>;
  memory: ProviderEditorDraft;
  modelSelection: ModelSelectionActions;
  onDraftsChanged(providers: ModelProviderGroup[]): void;
  onSaved(providers: ModelProviderGroup[], savedProviderId?: string): void;
};

function renderProviderCards(params: ProviderCardRenderParams): void {
  const root = requiredElement<HTMLElement>(
    params.doc,
    `${config.addonRef}-model-providers`,
  );
  root.classList.add("pt-provider-list");
  root.replaceChildren(
    ...params.drafts.map((provider, providerIndex) =>
      createProviderCard(params, provider, providerIndex),
    ),
  );
}

function createProviderCard(
  params: ProviderCardRenderParams,
  provider: ModelProviderGroup,
  providerIndex: number,
): HTMLElement {
  const doc = params.doc;
  const card = htmlElement(doc, "section");
  card.className = "pt-provider-card";
  card.dataset.providerIndex = String(providerIndex);
  card.dataset.providerId = provider.id;
  const header = createProviderHeader(params, card, provider);
  const body = htmlElement(doc, "div");
  body.className = "pt-provider-body";
  body.id = `${config.addonRef}-provider-${provider.id}-body`;
  body.hidden = !params.openProviderIds.has(provider.id);
  header.querySelector("button")!.setAttribute("aria-controls", body.id);
  const connection = htmlElement(doc, "h3");
  connection.className = "pt-provider-section-title";
  connection.textContent = getString("pref-provider-connection");
  const name = labeledInput(
    doc,
    getString("pref-provider-name"),
    provider.name,
  );
  name.input.placeholder = getString("pref-provider-unnamed");
  name.input.addEventListener("input", () => {
    provider.name = name.input.value;
    updateProviderHeader(card, provider, params.activeModelId);
  });
  body.append(connection, name.wrap);

  const auth = labeledSelect(
    doc,
    getString("pref-auth-mode"),
    [
      ["codex_auth", "Codex Auth"],
      ["openai_compatible", "API Key"],
    ],
    provider.authMode,
  );
  auth.select.addEventListener("change", () => {
    const next = auth.select.value as ModelAuthMode;
    params.memory.switchAuth(provider, next);
    params.onDraftsChanged([...params.drafts]);
  });

  body.append(auth.wrap);
  if (provider.authMode === "openai_compatible") {
    const preset = labeledSelect(
      doc,
      getString("pref-provider-preset"),
      [
        ...PROVIDER_PRESETS.map((entry): [string, string] => [
          entry.id,
          entry.label,
        ]),
        ["custom", getString("pref-provider-custom")],
      ],
      provider.presetId || "custom",
    );
    preset.select.addEventListener("change", () => {
      params.memory.switchPreset(provider, preset.select.value);
      params.onDraftsChanged([...params.drafts]);
    });
    const protocol = labeledSelect(
      doc,
      getString("pref-provider-protocol"),
      API_PROTOCOLS,
      provider.protocol ?? "chat_completions",
    );
    const custom = (provider.presetId || "custom") === "custom";
    protocol.select.disabled = !custom;
    protocol.wrap.hidden = !custom;
    protocol.select.addEventListener("change", () => {
      provider.protocol = protocol.select.value as ApiProtocol;
      params.onDraftsChanged([...params.drafts]);
    });
    body.append(preset.wrap, protocol.wrap);
    const apiBase = labeledInput(
      doc,
      getString("pref-provider-api-base"),
      provider.apiBase,
    );
    apiBase.input.placeholder = "https://api.example.com/v1";
    apiBase.input.readOnly = (provider.presetId || "custom") !== "custom";
    const preview = htmlElement(doc, "p");
    preview.className = "pt-provider-hint";
    preview.setAttribute("aria-live", "polite");
    const updatePreview = () => {
      try {
        const endpoint = endpointPreview(
          resolveApiEndpoint(
            provider.apiBase,
            provider.protocol ?? "chat_completions",
          ),
        );
        preview.textContent = custom
          ? `${getString("pref-provider-endpoint")}: ${endpoint}`
          : getString("pref-provider-preset-hint", {
              args: {
                protocol:
                  API_PROTOCOLS.find(
                    ([id]) => id === (provider.protocol ?? "chat_completions"),
                  )?.[1] || "",
              },
            });
        preview.style.color = "";
      } catch (error) {
        preview.textContent = modelErrorMessage(error);
        preview.style.color = "#b42318";
      }
    };
    apiBase.input.addEventListener("input", () => {
      stopModelDiscovery(card);
      provider.apiBase = apiBase.input.value;
      updatePreview();
    });
    const apiKey = labeledInput(
      doc,
      getString("pref-provider-api-key"),
      provider.apiKey,
      "password",
    );
    apiKey.input.placeholder = "sk-…";
    apiKey.input.autocomplete = "off";
    apiKey.input.addEventListener("input", () => {
      stopModelDiscovery(card);
      provider.apiKey = apiKey.input.value;
    });
    updatePreview();
    apiBase.wrap.append(preview);
    body.append(apiBase.wrap, apiKey.wrap);
  }
  const timeout = labeledInput(
    doc,
    getString("pref-provider-timeout"),
    String(provider.timeoutSeconds ?? 120),
    "number",
  );
  timeout.input.min = "1";
  timeout.input.max = "3600";
  timeout.input.addEventListener("input", () => {
    provider.timeoutSeconds = Number(timeout.input.value);
  });
  body.append(timeout.wrap);

  const models = htmlElement(doc, "div");
  models.className = "pt-provider-models";
  const modelHeading = htmlElement(doc, "div");
  modelHeading.className = "pt-provider-model-heading";
  const modelTitle = htmlElement(doc, "strong");
  modelTitle.textContent = getString("pref-provider-models");
  modelTitle.className = "pt-provider-section-title";
  const addModel = actionButton(doc, "+");
  addModel.classList.add("pt-icon-button", "pt-add-model");
  addModel.title = getString("pref-provider-add-model");
  addModel.setAttribute("aria-label", getString("pref-provider-add-model"));
  addModel.addEventListener("click", () => {
    provider.models.push(createProviderModel());
    params.onDraftsChanged([...params.drafts]);
  });
  const modelActions = htmlElement(doc, "div");
  modelActions.className = "pt-model-heading-actions";
  if (provider.authMode === "openai_compatible") {
    const discover = actionButton(doc, getString("pref-provider-models-fetch"));
    discover.classList.add("pt-fetch-models");
    discover.addEventListener("click", () => {
      void discoverProviderModels(params, card, provider, discover);
    });
    modelActions.append(discover);
  }
  modelActions.append(addModel);
  modelHeading.append(modelTitle, modelActions);
  models.append(modelHeading);

  for (const model of provider.models) {
    models.append(createModelRow(params, card, provider, model));
  }

  body.append(models);
  const footer = htmlElement(doc, "div");
  footer.className = "pt-provider-footer";
  const save = actionButton(doc, getString("pref-provider-save"));
  save.classList.add("pt-save-button");
  save.addEventListener("click", () => {
    try {
      const stored = getModelProviderConfiguration();
      const saved = params.modelSelection.saveModelProviderConfiguration(
        params.drafts,
        stored.activeModelId,
      );
      params.onSaved(saved.providers, provider.id);
    } catch (error) {
      showCardStatus(card, String(error), true);
    }
  });
  const status = htmlElement(doc, "span");
  status.className = `${config.addonRef}-provider-status`;
  status.hidden = true;
  status.classList.add("pt-provider-status");
  status.setAttribute("role", "status");
  const removeProvider = actionButton(doc, getString("pref-provider-remove"));
  removeProvider.classList.add("pt-danger-button");
  removeProvider.addEventListener("click", () => {
    if (provider.models.some((model) => model.id === params.activeModelId)) {
      showCardStatus(
        card,
        getString("pref-provider-active-remove-error"),
        true,
      );
      return;
    }
    try {
      const next = params.drafts.filter((entry) => entry.id !== provider.id);
      const stored = getModelProviderConfiguration();
      if (stored.providers.some((entry) => entry.id === provider.id)) {
        const saved = params.modelSelection.saveModelProviderConfiguration(
          next,
          stored.activeModelId,
        );
        params.openProviderIds.delete(provider.id);
        params.onSaved(saved.providers);
      } else {
        params.openProviderIds.delete(provider.id);
        params.onDraftsChanged(next);
      }
    } catch (error) {
      showCardStatus(card, modelErrorMessage(error), true);
    }
  });
  footer.append(save, removeProvider);
  body.append(status, footer);
  card.append(header, body);
  updateProviderHeader(card, provider, params.activeModelId);
  card.dataset.providerIndex = String(providerIndex);
  card.dataset.providerId = provider.id;
  return card;
}

function stopModelDiscovery(card?: HTMLElement): void {
  for (const [owner, controller] of discoveryControllers) {
    if (card && owner !== card) continue;
    discoveryControllers.delete(owner);
    controller.abort(new Error("Model discovery cancelled"));
    if (card && owner.isConnected) showCardStatus(owner, "", false);
  }
  for (const [owner, close] of modelPickers) {
    if (card && owner !== card) continue;
    close();
  }
}

async function discoverProviderModels(
  params: ProviderCardRenderParams,
  card: HTMLElement,
  provider: ModelProviderGroup,
  button: HTMLButtonElement,
): Promise<void> {
  stopModelDiscovery(card);
  const controller = new AbortController();
  discoveryControllers.set(card, controller);
  button.disabled = true;
  showCardStatus(card, getString("pref-provider-models-fetching"), false);
  try {
    const models = await fetchProviderModels(
      { ...provider },
      { signal: controller.signal },
    );
    if (controller.signal.aborted || !card.isConnected) return;
    showCardStatus(card, "", false);
    const close = openModelPicker({
      root: requiredElement<HTMLElement>(
        params.doc,
        `zotero-prefpane-${config.addonRef}`,
      ),
      models,
      existing: new Set(provider.models.map((entry) => entry.model.trim())),
      trigger: button,
      onClose: () => modelPickers.delete(card),
      onConfirm(ids) {
        const existing = new Set(
          provider.models.map((entry) => entry.model.trim()),
        );
        const added = ids.filter((id) => !existing.has(id));
        if (!added.length) return;
        provider.models = provider.models.filter(
          (entry) => entry.model.trim() || entry.id === params.activeModelId,
        );
        provider.models.push(
          ...added.map((id) => ({ ...createProviderModel(id), effort: "" })),
        );
        params.onDraftsChanged([...params.drafts]);
        const nextCard = Array.from(
          params.doc.querySelectorAll(".pt-provider-card"),
        )
          .map((entry) => entry as unknown as HTMLElement)
          .find((entry) => entry.dataset.providerId === provider.id);
        if (nextCard) {
          showCardStatus(
            nextCard,
            getString("pref-provider-models-added", {
              args: { count: added.length },
            }),
            false,
          );
          nextCard
            .querySelector<HTMLButtonElement>(".pt-fetch-models")
            ?.focus();
        }
      },
    });
    modelPickers.set(card, close);
  } catch (error) {
    if (!controller.signal.aborted && card.isConnected) {
      showCardStatus(
        card,
        `${getString("pref-provider-models-fetch-failed")}: ${modelErrorMessage(error)}`,
        true,
      );
    }
  } finally {
    if (discoveryControllers.get(card) === controller)
      discoveryControllers.delete(card);
    button.disabled = false;
  }
}

function createModelRow(
  params: ProviderCardRenderParams,
  card: HTMLElement,
  provider: ModelProviderGroup,
  model: ProviderModel,
): HTMLElement {
  const doc = params.doc;
  const row = htmlElement(doc, "div");
  row.className = "pt-provider-model-row";
  const modelInput = htmlElement(doc, "input");
  modelInput.type = "text";
  modelInput.value = model.model;
  modelInput.placeholder = getString("pref-provider-model-id");
  modelInput.setAttribute("aria-label", getString("pref-provider-model-id"));
  applyInputStyle(modelInput);
  modelInput.classList.add("pt-model-input");
  modelInput.addEventListener("input", () => {
    model.model = modelInput.value;
    updateProviderHeader(card, provider, params.activeModelId);
  });
  row.append(modelInput);
  const modelWrap = htmlElement(doc, "div");
  modelWrap.className = "pt-provider-model";
  const settings = htmlElement(doc, "div");
  settings.className = "pt-model-controls";
  settings.id = `${config.addonRef}-model-${model.id}-controls`;
  settings.hidden = !params.openModelIds.has(model.id);

  if (provider.authMode === "codex_auth") {
    const effort = htmlElement(doc, "select");
    for (const value of ["auto", "low", "medium", "high", "xhigh"]) {
      const option = htmlElement(doc, "option");
      option.value = value;
      option.textContent = value;
      effort.append(option);
    }
    effort.value = model.effort || "medium";
    applyInputStyle(effort);
    effort.style.width = "100px";
    effort.addEventListener("change", () => {
      model.effort = effort.value;
    });
    effort.setAttribute("aria-label", getString("pref-provider-effort"));
    settings.append(effort);
  }

  const select = actionButton(
    doc,
    model.id === params.activeModelId
      ? getString("pref-provider-current")
      : getString("pref-provider-use"),
  );
  select.disabled = model.id === params.activeModelId;
  select.addEventListener("click", () => {
    try {
      const stored = getModelProviderConfiguration();
      const saved = params.modelSelection.saveModelProviderConfiguration(
        params.drafts,
        stored.activeModelId,
      );
      params.modelSelection.switchActiveModel(model.id);
      params.onSaved(saved.providers);
    } catch (error) {
      showCardStatus(card, String(error), true);
    }
  });

  const testChoices = htmlElement(doc, "div");
  testChoices.className = "pt-test-choices";
  testChoices.id = `${config.addonRef}-model-${model.id}-tests`;
  testChoices.hidden = true;
  testChoices.setAttribute("role", "group");
  testChoices.setAttribute("aria-label", getString("pref-provider-test"));
  const testToggle = actionButton(doc, getString("pref-provider-test"));
  testToggle.classList.add("pt-test-toggle");
  testToggle.setAttribute("aria-label", getString("pref-provider-test"));
  testToggle.setAttribute("aria-controls", testChoices.id);
  testToggle.setAttribute("aria-expanded", "false");
  const testChevron = htmlElement(doc, "span");
  testChevron.textContent = "▾";
  testChevron.setAttribute("aria-hidden", "true");
  testToggle.append(testChevron);
  const closeTestChoices = () => {
    testChoices.hidden = true;
    testToggle.setAttribute("aria-expanded", "false");
  };
  testToggle.addEventListener("click", () => {
    testChoices.hidden = !testChoices.hidden;
    testToggle.setAttribute("aria-expanded", String(!testChoices.hidden));
  });
  for (const [kind, label] of [
    ["text", getString("pref-codex-test")],
    ["image", getString("pref-provider-image-test")],
  ] as const) {
    const choice = actionButton(doc, label);
    choice.addEventListener("click", () => {
      closeTestChoices();
      testToggle.focus();
      void testDraftModel(card, provider, model, testToggle, kind);
    });
    testChoices.append(choice);
  }
  modelWrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !testChoices.hidden) {
      closeTestChoices();
      testToggle.focus();
      event.preventDefault();
      event.stopPropagation();
    }
  });

  const remove = actionButton(doc, "×");
  remove.title = getString("pref-provider-remove-model");
  remove.setAttribute("aria-label", getString("pref-provider-remove-model"));
  remove.addEventListener("click", () => {
    if (model.id === params.activeModelId) {
      showCardStatus(
        card,
        getString("pref-provider-active-model-remove-error"),
        true,
      );
      return;
    }
    provider.models = provider.models.filter((entry) => entry.id !== model.id);
    params.onDraftsChanged([...params.drafts]);
  });
  settings.append(select, remove);
  const options = actionButton(doc, "⋯");
  options.classList.add("pt-icon-button", "pt-model-options");
  options.title = getString("pref-provider-model-options");
  options.setAttribute("aria-label", getString("pref-provider-model-options"));
  options.setAttribute("aria-controls", settings.id);
  options.setAttribute("aria-expanded", String(!settings.hidden));
  options.addEventListener("click", () => {
    closeTestChoices();
    settings.hidden = !settings.hidden;
    if (settings.hidden) params.openModelIds.delete(model.id);
    else params.openModelIds.add(model.id);
    options.setAttribute("aria-expanded", String(!settings.hidden));
  });
  row.append(testToggle, options);
  modelWrap.append(row, testChoices, settings);
  return modelWrap;
}

async function testDraftModel(
  card: HTMLElement,
  provider: ModelProviderGroup,
  model: ProviderModel,
  button: HTMLButtonElement,
  kind: "text" | "image" = "text",
): Promise<void> {
  cancelConnectionTests();
  const controller = new AbortController();
  connectionTestControllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new Error("Connection test timed out")),
    kind === "image" ? 60_000 : CONNECTION_TEST_TIMEOUT_MS,
  );
  button.disabled = true;
  showCardStatus(card, getString("pref-codex-testing"), false);
  try {
    const runtime = resolveDraftRuntimeModel(provider, model);
    const reply =
      kind === "image"
        ? await testModelImageConnection(runtime, controller.signal)
        : await testModelConnection(runtime, controller.signal);
    if (controller.signal.aborted || !card.isConnected) return;
    showCardStatus(card, `${getString("pref-codex-success")}: ${reply}`, false);
  } catch (error) {
    if (!card.isConnected || !connectionTestControllers.has(controller)) return;
    showCardStatus(
      card,
      `${getString("pref-codex-failed")}: ${modelErrorMessage(error)}`,
      true,
    );
  } finally {
    clearTimeout(timer);
    connectionTestControllers.delete(controller);
    button.disabled = false;
  }
}

function bindSourceLanguage(doc: Document): void {
  const field = requiredElement<HTMLInputElement>(
    doc,
    `${config.addonRef}-sourceLanguage`,
  );
  field.value = String(getPref("sourceLanguage") ?? "");
  field.addEventListener("change", () =>
    setPref("sourceLanguage", field.value.trim()),
  );
}

function showCardStatus(
  card: HTMLElement,
  message: string,
  error: boolean,
): void {
  const status = card.querySelector(
    `.${config.addonRef}-provider-status`,
  ) as HTMLElement | null;
  if (!status) return;
  status.hidden = !message;
  status.style.color = error ? "#b42318" : "#168c68";
  status.textContent = message;
}

function cancelConnectionTests(): void {
  for (const controller of connectionTestControllers) controller.abort();
  connectionTestControllers.clear();
}

function nextProviderName(providers: ModelProviderGroup[]): string {
  const existing = new Set(providers.map((provider) => provider.name.trim()));
  for (let index = 0; index < 26; index += 1) {
    const letter = String.fromCharCode(65 + index);
    const candidate = getString("pref-provider-default-name", {
      args: { letter },
    });
    if (!existing.has(candidate)) return candidate;
  }
  return getString("pref-provider-default-name", {
    args: { letter: String(providers.length + 1) },
  });
}

function labeledInput(
  doc: Document,
  labelText: string,
  value: string,
  type = "text",
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = fieldWrap(doc, labelText);
  const input = htmlElement(doc, "input");
  input.type = type;
  input.value = value;
  input.setAttribute("aria-label", labelText);
  applyInputStyle(input);
  wrap.append(input);
  return { wrap, input };
}

function labeledSelect(
  doc: Document,
  labelText: string,
  options: Array<[string, string]>,
  value: string,
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = fieldWrap(doc, labelText);
  const select = htmlElement(doc, "select");
  select.setAttribute("aria-label", labelText);
  for (const [optionValue, text] of options) {
    const option = htmlElement(doc, "option");
    option.value = optionValue;
    option.textContent = text;
    select.append(option);
  }
  select.value = value;
  applyInputStyle(select);
  wrap.append(select);
  return { wrap, select };
}

function fieldWrap(doc: Document, labelText: string): HTMLElement {
  const wrap = htmlElement(doc, "label");
  wrap.className = "pt-provider-field";
  const label = htmlElement(doc, "span");
  label.textContent = labelText;
  label.className = "pt-provider-field-label";
  wrap.append(label);
  return wrap;
}

function applyInputStyle(input: HTMLInputElement | HTMLSelectElement): void {
  input.classList.add("pt-provider-input");
}

function actionButton(doc: Document, text: string): HTMLButtonElement {
  const button = htmlElement(doc, "button");
  button.type = "button";
  button.textContent = text;
  button.classList.add("pt-provider-button");
  return button;
}

function htmlElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
}

function requiredElement<T extends Element>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element)
    throw new Error(`Required preferences element is missing: ${id}`);
  return element as unknown as T;
}

function ensureProviderStyles(doc: Document): void {
  const id = `${config.addonRef}-provider-styles`;
  if (doc.getElementById(id)) return;
  const stylesheet = htmlElement(doc, "link");
  stylesheet.id = id;
  stylesheet.rel = "stylesheet";
  stylesheet.href = `chrome://${config.addonRef}/content/providerPreferences.css`;
  (doc.head || doc.documentElement).append(stylesheet);
}

function providerBrand(provider: ModelProviderGroup): string {
  if (provider.authMode === "codex_auth") return "Codex";
  const preset = PROVIDER_PRESETS.find(
    (entry) => entry.id === provider.presetId,
  );
  if (preset) return preset.label.split(" · ")[0];
  try {
    const host = new URL(provider.apiBase).hostname;
    if (host === "api.openai.com") return "OpenAI";
    if (host === "api.anthropic.com") return "Anthropic";
    if (host === "api.deepseek.com") return "DeepSeek";
  } catch {
    /* An unfinished custom draft has no brand. */
  }
  return getString("pref-provider-custom");
}

function createProviderHeader(
  params: ProviderCardRenderParams,
  card: HTMLElement,
  provider: ModelProviderGroup,
): HTMLElement {
  const doc = params.doc;
  const header = htmlElement(doc, "div");
  header.className = "pt-provider-head";
  const icon = htmlElement(doc, "span");
  icon.className = "pt-provider-brand-icon";
  icon.setAttribute("aria-hidden", "true");
  const toggle = actionButton(doc, "");
  toggle.className = "pt-provider-toggle";
  toggle.setAttribute(
    "aria-expanded",
    String(params.openProviderIds.has(provider.id)),
  );
  const name = htmlElement(doc, "span");
  name.className = "pt-provider-title";
  const meta = htmlElement(doc, "span");
  meta.className = "pt-provider-meta";
  const dot = htmlElement(doc, "span");
  dot.className = "pt-provider-dot";
  const summary = htmlElement(doc, "span");
  summary.className = "pt-provider-summary";
  meta.append(dot, summary);
  toggle.append(name, meta);
  const tag = htmlElement(doc, "span");
  tag.className = "pt-provider-tag";
  const chevron = htmlElement(doc, "span");
  chevron.className = "pt-provider-chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  toggle.addEventListener("click", () => {
    const open = !params.openProviderIds.has(provider.id);
    if (open) params.openProviderIds.add(provider.id);
    else params.openProviderIds.delete(provider.id);
    card.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    (card.querySelector(".pt-provider-body") as HTMLElement).hidden = !open;
  });
  header.append(icon, toggle, tag, chevron);
  header.addEventListener("click", (event) => {
    if (!(event.target as Element).closest(".pt-provider-toggle"))
      toggle.click();
  });
  return header;
}

function updateProviderHeader(
  card: HTMLElement,
  provider: ModelProviderGroup,
  activeModelId: string,
): void {
  const brand = providerBrand(provider);
  const active = provider.models.find((entry) => entry.id === activeModelId);
  const model = active || provider.models.find((entry) => entry.model.trim());
  const title = card.querySelector(".pt-provider-title") as HTMLElement;
  title.textContent =
    provider.name.trim() || getString("pref-provider-unnamed");
  const summary = card.querySelector(".pt-provider-summary") as HTMLElement;
  summary.textContent = `${brand} · ${provider.authMode === "codex_auth" ? getString("pref-provider-login") : "API"} · ${model?.model.trim() || getString("pref-provider-model-unset")}`;
  const tag = card.querySelector(".pt-provider-tag") as HTMLElement;
  tag.textContent =
    provider.authMode === "codex_auth"
      ? getString("pref-provider-codex-auth")
      : getString("pref-provider-key-auth");
  const dot = card.querySelector(".pt-provider-dot") as HTMLElement;
  dot.dataset.current = String(Boolean(active));
  dot.title = active
    ? getString("pref-provider-current")
    : getString("pref-provider-not-current");
  card.dataset.open =
    card.querySelector(".pt-provider-toggle")!.getAttribute("aria-expanded") ||
    "false";
  const icon = card.querySelector(".pt-provider-brand-icon") as HTMLElement;
  const iconId =
    brand === "Codex" || brand === "OpenAI"
      ? "openai"
      : brand === "Anthropic"
        ? "anthropic"
        : brand === "DeepSeek"
          ? "deepseek"
          : "";
  if (icon.dataset.brand !== iconId || !icon.firstChild) {
    icon.dataset.brand = iconId;
    if (iconId) {
      const image = htmlElement(card.ownerDocument, "img");
      image.src = `chrome://${config.addonRef}/content/icons/providers/${iconId}.svg`;
      image.alt = "";
      icon.replaceChildren(image);
    } else icon.textContent = "AI";
  }
}

function bindPreferenceTabs(
  doc: Document,
  initial: number,
  onChange: (tab: number) => void,
): void {
  const tabs = ["providers", "translation"].map(
    (id) =>
      doc.getElementById(
        `${config.addonRef}-${id}-tab`,
      ) as HTMLButtonElement | null,
  );
  if (tabs.some((tab) => !tab)) return;
  const selectTab = (selected: number, focus = false) => {
    tabs.forEach((tab, index) => {
      tab!.setAttribute("aria-selected", String(index === selected));
      tab!.tabIndex = index === selected ? 0 : -1;
      const panel = doc.getElementById(
        tab!.getAttribute("aria-controls") || "",
      );
      if (panel) panel.hidden = index !== selected;
    });
    if (focus) tabs[selected]!.focus();
    onChange(selected);
  };
  tabs.forEach((tab, index) => {
    tab!.addEventListener("click", () => selectTab(index));
    tab!.addEventListener("keydown", (event) => {
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      selectTab(next, true);
    });
  });
  selectTab(initial);
}
