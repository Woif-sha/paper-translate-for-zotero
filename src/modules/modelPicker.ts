import { getString } from "../utils/locale";
import type { DiscoveredModel } from "../models/modelDiscovery";
import { hideModelByDefault } from "../models/modelCatalogFilter";

export function openModelPicker(params: {
  root: HTMLElement;
  models: DiscoveredModel[];
  existing: Set<string>;
  trigger: HTMLButtonElement;
  onConfirm(ids: string[]): void;
  onClose(): void;
}): () => void {
  const doc = params.root.ownerDocument;
  const dialog = element(doc, "dialog");
  dialog.className = "pt-model-picker";
  dialog.setAttribute("aria-label", getString("pref-provider-models-choose"));
  dialog.setAttribute("aria-modal", "true");
  const title = element(doc, "strong");
  title.className = "pt-model-picker-title";
  title.textContent = getString("pref-provider-models-choose");
  const hint = element(doc, "p");
  hint.className = "pt-model-picker-hint";
  hint.textContent = getString("pref-provider-models-choose-hint");
  const search = element(doc, "input");
  search.type = "search";
  search.className = "pt-provider-input";
  search.placeholder = getString("pref-provider-models-search");
  search.setAttribute("aria-label", search.placeholder);
  const filterBar = element(doc, "div");
  filterBar.className = "pt-model-picker-filterbar";
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
  const filterStatus = element(doc, "span");
  filterStatus.className = "pt-model-picker-filter-status";
  filterStatus.setAttribute("role", "status");
  filterBar.append(toggleLabel, filterStatus);
  const list = element(doc, "div");
  list.className = "pt-model-picker-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", getString("pref-provider-models-choose"));
  const selected = new Set<string>();
  const confirm = button(
    doc,
    getString("pref-provider-models-add-selected", {
      args: { count: 0 },
    }),
  );
  confirm.classList.add("pt-save-button");
  const updateCount = () => {
    confirm.textContent = getString("pref-provider-models-add-selected", {
      args: { count: selected.size },
    });
    confirm.setAttribute("aria-label", confirm.textContent);
    confirm.disabled = selected.size === 0;
  };
  const rows = params.models.map((model) => {
    const row = element(doc, "label");
    row.className = "pt-model-picker-row";
    const checkbox = element(doc, "input");
    checkbox.type = "checkbox";
    checkbox.value = model.id;
    checkbox.setAttribute("aria-label", model.id);
    checkbox.checked = params.existing.has(model.id);
    checkbox.disabled = checkbox.checked;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(model.id);
      else selected.delete(model.id);
      updateCount();
    });
    const text = element(doc, "span");
    text.className = "pt-model-picker-model";
    const id = element(doc, "span");
    id.textContent = model.id;
    text.append(id);
    if (model.name && model.name !== model.id) {
      const name = element(doc, "small");
      name.textContent = model.name;
      text.append(name);
    }
    row.append(checkbox, text);
    if (checkbox.disabled) {
      const badge = element(doc, "small");
      badge.className = "pt-model-picker-added";
      badge.textContent = getString("pref-provider-model-already-added");
      row.append(badge);
    }
    list.append(row);
    return {
      row,
      checkbox,
      excluded: hideModelByDefault(model),
      searchText: `${model.id} ${model.name}`.toLowerCase(),
    };
  });
  const empty = element(doc, "p");
  empty.className = "pt-model-picker-hint";
  empty.textContent = getString("pref-provider-models-no-match");
  empty.setAttribute("role", "status");
  empty.hidden = true;
  list.append(empty);
  const excludedCount = rows.filter(({ excluded }) => excluded).length;
  const updateVisibility = () => {
    const query = search.value.trim().toLowerCase();
    for (const { row, excluded, searchText } of rows)
      row.hidden =
        (!showAll.checked && excluded) || !searchText.includes(query);
    empty.textContent = getString(
      !showAll.checked && excludedCount
        ? "pref-provider-models-no-match-filtered"
        : "pref-provider-models-no-match",
    );
    empty.hidden = rows.some(({ row }) => !row.hidden);
  };
  const updateFilterStatus = (cleared = false) => {
    filterStatus.textContent =
      showAll.checked || !excludedCount
        ? getString("pref-provider-models-total", {
            args: { count: rows.length },
          })
        : getString("pref-provider-models-hidden", {
            args: { count: excludedCount },
          });
    if (cleared)
      filterStatus.textContent += ` ${getString("pref-provider-models-hidden-cleared")}`;
  };
  search.addEventListener("input", updateVisibility);
  showAll.addEventListener("change", () => {
    let cleared = false;
    if (!showAll.checked) {
      for (const { excluded, checkbox } of rows) {
        if (!excluded || checkbox.disabled || !selected.delete(checkbox.value))
          continue;
        checkbox.checked = false;
        cleared = true;
      }
      updateCount();
    }
    updateVisibility();
    updateFilterStatus(cleared);
  });
  updateVisibility();
  updateFilterStatus();
  const footer = element(doc, "div");
  footer.className = "pt-model-picker-footer";
  const cancel = button(doc, getString("pref-provider-models-cancel"));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    dialog.remove();
    params.onClose();
    if (params.trigger.isConnected) params.trigger.focus();
  };
  confirm.addEventListener("click", () => {
    if (!selected.size) return;
    const ids = params.models
      .filter((model) => selected.has(model.id))
      .map((model) => model.id);
    close();
    params.onConfirm(ids);
  });
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", close);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const controls = Array.from(
        dialog.querySelectorAll("button:not(:disabled), input:not(:disabled)"),
      )
        .map((node) => node as unknown as HTMLElement)
        .filter((node) => !node.closest("[hidden]"));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  updateCount();
  footer.append(cancel, confirm);
  dialog.append(title, hint, search, filterBar, list, footer);
  params.root.append(dialog);
  try {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch (error) {
    close();
    throw error;
  }
  search.focus();
  return close;
}

function button(doc: Document, label: string): HTMLButtonElement {
  const result = element(doc, "button");
  result.type = "button";
  result.className = "pt-provider-button";
  result.textContent = label;
  result.setAttribute("aria-label", label);
  return result;
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
