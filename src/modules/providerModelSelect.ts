import type { DiscoveredModel } from "../models/modelDiscovery";
import { hideModelByDefault } from "../models/modelCatalogFilter";
import { getString } from "../utils/locale";

export function attachProviderModelSelect(args: {
  input: HTMLInputElement;
  initialModels?: DiscoveredModel[];
  // The loader must redact credentials from errors before rejecting.
  loadModels(options?: { force?: boolean }): Promise<DiscoveredModel[]>;
  onModelPicked(id: string): void;
}): {
  container: HTMLElement;
  details: HTMLElement;
  setModels(models: DiscoveredModel[]): void;
  reset(): void;
  dispose(): void;
} {
  const { input } = args;
  const doc = input.ownerDocument;
  const container = element(doc, "div");
  container.className = "pt-provider-model-select-slot";
  const select = element(doc, "select");
  select.className = "pt-provider-input pt-provider-model-select";
  select.setAttribute("aria-label", getString("pref-provider-model-select"));
  const refresh = element(doc, "button");
  refresh.type = "button";
  refresh.className = "pt-provider-button pt-provider-model-refresh";
  refresh.textContent = getString("pref-provider-models-refresh");
  container.append(select, input, refresh);
  const details = element(doc, "div");
  details.className = "pt-provider-model-select-details";
  const toggleLabel = element(doc, "label");
  toggleLabel.className = "pt-model-picker-toggle";
  const showAll = element(doc, "input");
  showAll.type = "checkbox";
  showAll.setAttribute(
    "aria-label",
    getString("pref-provider-models-show-all"),
  );
  const toggleText = element(doc, "span");
  toggleText.textContent = getString("pref-provider-models-show-all");
  toggleLabel.append(showAll, toggleText);
  const status = element(doc, "span");
  status.className = "pt-provider-model-select-status";
  status.setAttribute("role", "status");
  details.append(toggleLabel, status);

  let models = args.initialModels ?? [];
  let manual = false;
  let loading = false;
  let failureDetail: string | undefined;
  let generation = 0;
  let requestToken = 0;
  let disposed = false;
  let renderedSignature = "";
  const rebuild = () => {
    if (disposed) return;
    input.hidden = !manual;
    select.hidden = manual;
    const saved = input.value;
    const visible = models.filter(
      (model) => showAll.checked || !hideModelByDefault(model),
    );
    const ids = visible.map((model) => model.id);
    if (saved && !ids.includes(saved)) ids.unshift(saved);
    const signature = JSON.stringify([ids, saved, manual]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    select.textContent = "";
    if (!saved) {
      const placeholder = element(doc, "option");
      placeholder.value = "";
      placeholder.textContent = getString("pref-provider-model-select");
      placeholder.disabled = true;
      select.append(placeholder);
    }
    for (const id of ids) {
      const option = element(doc, "option");
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
    const customized = element(doc, "option");
    customized.value = "__pt-custom-model__";
    customized.textContent = getString("pref-provider-model-custom");
    select.append(customized);
    if (manual) select.selectedIndex = select.options.length - 1;
    else select.value = saved;
  };
  const rebuildGate = createSelectRebuildGate(rebuild);
  const updateStatus = () => {
    refresh.disabled = loading;
    delete status.dataset.error;
    if (loading) {
      status.textContent = getString("pref-provider-models-fetching");
    } else if (failureDetail !== undefined) {
      status.textContent =
        getString("pref-provider-models-fetch-failed") +
        (failureDetail ? `: ${failureDetail}` : "");
      status.dataset.error = "true";
    } else if (models.length) {
      const hidden = models.filter(hideModelByDefault).length;
      status.textContent =
        !showAll.checked && hidden
          ? getString("pref-provider-models-hidden", {
              args: { count: hidden },
            })
          : getString("pref-provider-models-total", {
              args: { count: models.length },
            });
    } else {
      status.textContent = "";
    }
  };
  const setModels = (catalog: DiscoveredModel[]) => {
    if (disposed) return;
    models = catalog;
    failureDetail = undefined;
    rebuildGate.requestRebuild();
    updateStatus();
  };
  const refreshCatalog = async (options?: { force?: boolean }) => {
    if (disposed) return;
    const currentGeneration = generation;
    const token = ++requestToken;
    loading = true;
    failureDetail = undefined;
    updateStatus();
    try {
      const catalog = await args.loadModels(options);
      if (
        disposed ||
        currentGeneration !== generation ||
        token !== requestToken
      )
        return;
      models = catalog;
    } catch (error) {
      if (
        disposed ||
        currentGeneration !== generation ||
        token !== requestToken
      )
        return;
      failureDetail = error instanceof Error ? error.message : String(error);
    }
    loading = false;
    rebuildGate.requestRebuild();
    updateStatus();
  };
  const onFocus = () => void refreshCatalog();
  const onMouseDown = () => {
    rebuildGate.popupMayOpen();
    void refreshCatalog();
  };
  const onSelectKeyDown = () => rebuildGate.popupMayOpen();
  const onSelectBlur = () => rebuildGate.popupClosed();
  const onSelectChange = () => {
    const chosen = select.value;
    const customized = select.selectedIndex === select.options.length - 1;
    const currentGeneration = generation;
    runAfterSelectChangeDispatch(() => {
      if (disposed || currentGeneration !== generation) return;
      rebuildGate.popupClosed();
      manual = customized;
      if (customized) {
        rebuildGate.requestRebuild();
        input.focus();
      } else if (chosen) {
        input.value = chosen;
        args.onModelPicked(chosen);
        rebuildGate.requestRebuild();
      }
    });
  };
  const onInputBlur = () => {
    manual = false;
    rebuildGate.requestRebuild();
  };
  const onInputKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") input.blur();
  };
  const onRefresh = () => void refreshCatalog({ force: true });
  const onShowAll = () => {
    rebuildGate.requestRebuild();
    updateStatus();
  };
  select.addEventListener("focus", onFocus);
  select.addEventListener("mousedown", onMouseDown);
  select.addEventListener("keydown", onSelectKeyDown);
  select.addEventListener("blur", onSelectBlur);
  select.addEventListener("change", onSelectChange);
  input.addEventListener("blur", onInputBlur);
  input.addEventListener("keydown", onInputKeyDown);
  refresh.addEventListener("click", onRefresh);
  showAll.addEventListener("change", onShowAll);
  rebuild();
  updateStatus();
  return {
    container,
    details,
    setModels,
    reset() {
      if (disposed) return;
      generation += 1;
      models = [];
      loading = false;
      failureDetail = undefined;
      showAll.checked = false;
      rebuildGate.requestRebuild();
      updateStatus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener("focus", onFocus);
      select.removeEventListener("mousedown", onMouseDown);
      select.removeEventListener("keydown", onSelectKeyDown);
      select.removeEventListener("blur", onSelectBlur);
      select.removeEventListener("change", onSelectChange);
      input.removeEventListener("blur", onInputBlur);
      input.removeEventListener("keydown", onInputKeyDown);
      refresh.removeEventListener("click", onRefresh);
      showAll.removeEventListener("change", onShowAll);
    },
  };
}

// Native-select popup lifecycle follows llm-for-zotero e99ab047 (AGPL-3.0).
// Rewriting options while Gecko's popup may be open can crash SelectChild;
// flush after change/blur, or immediately before the next opening interaction.
function createSelectRebuildGate(rebuild: () => void) {
  let mayBeOpen = false;
  let pending = false;
  const flush = () => {
    if (!pending) return;
    pending = false;
    rebuild();
  };
  return {
    requestRebuild: () => {
      if (mayBeOpen) {
        pending = true;
        return;
      }
      rebuild();
    },
    popupMayOpen: () => {
      flush();
      mayBeOpen = true;
    },
    popupClosed: () => {
      mayBeOpen = false;
      flush();
    },
  };
}

function runAfterSelectChangeDispatch(work: () => void): void {
  // Gecko tears down the native popup after change dispatch returns.
  void Promise.resolve().then(work);
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  name: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    name,
  ) as HTMLElementTagNameMap[K];
}
