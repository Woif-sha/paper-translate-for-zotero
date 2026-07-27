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

export const PREFERENCES_PANE_ID = `${config.addonRef}-preferences`;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;
let preferencesRegistered = false;
const connectionTestControllers = new Set<AbortController>();

export async function registerPrefsWindow(): Promise<void> {
  if (preferencesRegistered) return;
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    id: PREFERENCES_PANE_ID,
    src: rootURI + "chrome/content/preferences.xhtml",
    label: "paper-translate-for-zotero",
    image: `chrome://${config.addonRef}/content/icons/section-20.png`,
    helpURL: homepage,
  });
  preferencesRegistered = true;
}

export function unregisterPrefsWindow(): void {
  cancelConnectionTests();
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
  bindSourceLanguage(doc);
  let drafts = cloneProviders(getModelProviderConfiguration().providers);

  const render = () => {
    const configuration = getModelProviderConfiguration();
    renderProviderCards({
      doc,
      drafts,
      activeModelId: configuration.activeModelId,
      modelSelection,
      onDraftsChanged(next) {
        drafts = next;
        render();
      },
      onSaved(saved, savedProviderId) {
        drafts = cloneProviders(saved);
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
  };

  const add = requiredElement<HTMLButtonElement>(
    doc,
    `${config.addonRef}-add-provider`,
  );
  add.addEventListener("click", () => {
    const provider = createProviderGroup("openai_compatible");
    provider.name = nextProviderName(drafts);
    provider.models.push(createProviderModel());
    drafts = [...drafts, provider];
    render();
  });
  const unsubscribe = subscribeModelConfiguration(render);
  window.addEventListener(
    "unload",
    () => {
      unsubscribe();
      cancelConnectionTests();
    },
    { once: true },
  );
  render();
}

type ProviderCardRenderParams = {
  doc: Document;
  drafts: ModelProviderGroup[];
  activeModelId: string;
  modelSelection: ModelSelectionActions;
  onDraftsChanged(providers: ModelProviderGroup[]): void;
  onSaved(providers: ModelProviderGroup[], savedProviderId?: string): void;
};

function renderProviderCards(params: ProviderCardRenderParams): void {
  const root = requiredElement<HTMLElement>(
    params.doc,
    `${config.addonRef}-model-providers`,
  );
  Object.assign(root.style, {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  });
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
  Object.assign(card.style, {
    padding: "10px",
    border: "1px solid var(--fill-quinary, #d2d2d2)",
    borderRadius: "8px",
    background: "var(--material-background, #fff)",
  });

  const header = htmlElement(doc, "div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "10px",
  });
  const name = htmlElement(doc, "input");
  name.type = "text";
  name.value = provider.name;
  name.placeholder = getString("pref-provider-unnamed");
  name.setAttribute("aria-label", getString("pref-provider-name"));
  Object.assign(name.style, {
    boxSizing: "border-box",
    flex: "1",
    minWidth: "0",
    padding: "5px 8px",
    fontWeight: "600",
  });
  name.addEventListener("input", () => {
    provider.name = name.value;
  });
  const removeProvider = actionButton(doc, "×");
  removeProvider.title = getString("pref-provider-remove");
  removeProvider.setAttribute("aria-label", getString("pref-provider-remove"));
  removeProvider.addEventListener("click", () => {
    if (provider.models.some((model) => model.id === params.activeModelId)) {
      showCardStatus(
        card,
        getString("pref-provider-active-remove-error"),
        true,
      );
      return;
    }
    const next = params.drafts.filter((entry) => entry.id !== provider.id);
    const stored = getModelProviderConfiguration();
    if (stored.providers.some((entry) => entry.id === provider.id)) {
      const saved = params.modelSelection.saveModelProviderConfiguration(
        next,
        stored.activeModelId,
      );
      params.onSaved(saved.providers);
      return;
    }
    params.onDraftsChanged(next);
  });
  header.append(name, removeProvider);

  const auth = labeledSelect(
    doc,
    getString("pref-auth-mode"),
    [
      ["codex_auth", "Codex Auth"],
      ["openai_compatible", "OpenAI Compatible"],
    ],
    provider.authMode,
  );
  auth.select.addEventListener("change", () => {
    const next = auth.select.value as ModelAuthMode;
    provider.authMode = next;
    provider.apiBase = "";
    provider.apiKey = "";
    for (const model of provider.models) {
      model.effort = next === "codex_auth" ? "medium" : "";
    }
    params.onDraftsChanged([...params.drafts]);
  });

  card.append(header, auth.wrap);
  if (provider.authMode === "openai_compatible") {
    const apiBase = labeledInput(
      doc,
      getString("pref-provider-api-base"),
      provider.apiBase,
    );
    apiBase.input.placeholder = "https://api.example.com/v1";
    apiBase.input.addEventListener("input", () => {
      provider.apiBase = apiBase.input.value;
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
      provider.apiKey = apiKey.input.value;
    });
    card.append(apiBase.wrap, apiKey.wrap);
  }

  const modelHeading = htmlElement(doc, "div");
  Object.assign(modelHeading.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "10px",
    marginBottom: "6px",
  });
  const modelTitle = htmlElement(doc, "strong");
  modelTitle.textContent = getString("pref-provider-models");
  modelTitle.style.flex = "1";
  const addModel = actionButton(doc, "+");
  addModel.title = getString("pref-provider-add-model");
  addModel.setAttribute("aria-label", getString("pref-provider-add-model"));
  addModel.addEventListener("click", () => {
    provider.models.push(createProviderModel());
    params.onDraftsChanged([...params.drafts]);
  });
  modelHeading.append(modelTitle, addModel);
  card.append(modelHeading);

  for (const model of provider.models) {
    card.append(createModelRow(params, card, provider, model));
  }

  const footer = htmlElement(doc, "div");
  Object.assign(footer.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginTop: "10px",
  });
  const save = actionButton(doc, getString("pref-provider-save"));
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
  Object.assign(status.style, {
    flex: "1",
    overflowWrap: "anywhere",
    fontSize: "0.9em",
  });
  footer.append(save, status);
  card.append(footer);
  card.dataset.providerIndex = String(providerIndex);
  card.dataset.providerId = provider.id;
  return card;
}

function createModelRow(
  params: ProviderCardRenderParams,
  card: HTMLElement,
  provider: ModelProviderGroup,
  model: ProviderModel,
): HTMLElement {
  const doc = params.doc;
  const row = htmlElement(doc, "div");
  Object.assign(row.style, {
    display: "grid",
    gridTemplateColumns:
      provider.authMode === "codex_auth"
        ? "minmax(120px, 1fr) 110px auto auto auto"
        : "minmax(120px, 1fr) auto auto auto",
    gap: "6px",
    alignItems: "center",
    marginBottom: "6px",
  });
  const modelInput = htmlElement(doc, "input");
  modelInput.type = "text";
  modelInput.value = model.model;
  modelInput.placeholder = getString("pref-provider-model-id");
  applyInputStyle(modelInput);
  modelInput.addEventListener("input", () => {
    model.model = modelInput.value;
  });
  row.append(modelInput);

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
    effort.addEventListener("change", () => {
      model.effort = effort.value;
    });
    row.append(effort);
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

  const test = actionButton(doc, getString("pref-codex-test"));
  test.addEventListener("click", () => {
    void testDraftModel(card, provider, model, test);
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
  row.append(select, test, remove);
  return row;
}

async function testDraftModel(
  card: HTMLElement,
  provider: ModelProviderGroup,
  model: ProviderModel,
  button: HTMLButtonElement,
): Promise<void> {
  cancelConnectionTests();
  const controller = new AbortController();
  connectionTestControllers.add(controller);
  const timer = setTimeout(
    () => controller.abort(new Error("Connection test timed out")),
    CONNECTION_TEST_TIMEOUT_MS,
  );
  button.disabled = true;
  showCardStatus(card, getString("pref-codex-testing"), false);
  try {
    const runtime = resolveDraftRuntimeModel(provider, model);
    const reply = await testModelConnection(runtime, controller.signal);
    showCardStatus(card, `${getString("pref-codex-success")}: ${reply}`, false);
  } catch (error) {
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
  status.hidden = false;
  status.style.color = error ? "#b42318" : "#168c68";
  status.textContent = message;
}

function cancelConnectionTests(): void {
  for (const controller of connectionTestControllers) controller.abort();
  connectionTestControllers.clear();
}

function cloneProviders(providers: ModelProviderGroup[]): ModelProviderGroup[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  }));
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
  Object.assign(wrap.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "8px",
  });
  const label = htmlElement(doc, "span");
  label.textContent = labelText;
  label.style.fontWeight = "600";
  wrap.append(label);
  return wrap;
}

function applyInputStyle(input: HTMLInputElement | HTMLSelectElement): void {
  Object.assign(input.style, {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    padding: "6px 8px",
  });
}

function actionButton(doc: Document, text: string): HTMLButtonElement {
  const button = htmlElement(doc, "button");
  button.type = "button";
  button.textContent = text;
  Object.assign(button.style, {
    padding: "4px 9px",
    whiteSpace: "nowrap",
  });
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
