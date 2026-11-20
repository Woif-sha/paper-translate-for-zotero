export const FULLTEXT_READING_MODES = [
  { id: "mode-bi", label: "双语" },
  { id: "mode-zh", label: "中文" },
  { id: "mode-en", label: "原文" },
] as const;

const listeners = new WeakMap<Document, AbortController>();

export function renderFulltextReadingControls(): string {
  return (
    '<nav id="fulltext-reading-modes" aria-label="阅读模式" hidden>' +
    FULLTEXT_READING_MODES.map(
      ({ id, label }, index) =>
        '<label><input type="radio" name="mode" id="' +
        id +
        '"' +
        (index === 0 ? " checked" : "") +
        "> " +
        label +
        "</label>",
    ).join("") +
    "</nav>"
  );
}

export function appendFulltextReadingModes(
  doc: Document,
  append: (node: Node) => void,
): void {
  listeners.get(doc)?.abort();
  const controller = new (
    doc.defaultView?.AbortController ?? AbortController
  )();
  listeners.set(doc, controller);

  const group = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "阅读模式");
  group.style.display = "flex";
  group.style.alignItems = "center";
  group.style.gap = "2px";
  let selected = 0;
  const watched = new WeakSet<HTMLIFrameElement>();
  const buttons = FULLTEXT_READING_MODES.map(({ label }, index) => {
    const button = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    );
    button.setAttribute("type", "button");
    button.setAttribute("class", "toolbar-button");
    button.textContent = label;
    button.style.width = "auto";
    button.style.minWidth = "32px";
    button.style.paddingInline = "4px";
    button.addEventListener("click", () => {
      selected = index;
      update();
    });
    group.append(button);
    return button;
  });

  function update(): void {
    const frames = Array.from(
      doc.querySelectorAll("iframe"),
    ) as unknown as HTMLIFrameElement[];
    for (const frame of frames) {
      try {
        const source = frame.getAttribute("srcdoc") ?? "";
        if (source.includes('id="fulltext-reading-modes"')) {
          const html = source.replace(
            /<nav\b([^>]*\bid=["\x27]fulltext-reading-modes["\x27][^>]*)>/iu,
            (tag) =>
              /\shidden(?:\s|=|>)/iu.test(tag)
                ? tag
                : tag.replace(/>$/u, " hidden>"),
          );
          if (html !== source) frame.setAttribute("srcdoc", html);
        }
      } catch {
        // The view can be replaced while the toolbar is rendering.
      }
      if (!watched.has(frame)) {
        frame.addEventListener("load", update, { signal: controller.signal });
        watched.add(frame);
      }
      let content: Document | null;
      try {
        content = frame.contentDocument;
      } catch {
        continue;
      }
      if (!content?.querySelector("main section[data-block-id]")) continue;
      const radios = FULLTEXT_READING_MODES.map(({ id }) =>
        content.querySelector<HTMLInputElement>(
          'input[type="radio"][name="mode"]#' + id,
        ),
      );
      const controls = radios[0]?.closest(
        "nav#fulltext-reading-modes, fieldset",
      );
      const radio = radios[selected];
      if (
        !controls ||
        !radio ||
        radios.some((input) => !input || !controls.contains(input))
      )
        continue;
      radio.checked = true;
      (controls as HTMLElement).hidden = true;
      // Older exports contain a second heading above the Markdown title.
      content.querySelector("body > header > h1")?.remove();
    }
    for (const [index, button] of buttons.entries()) {
      button.classList.toggle("active", index === selected);
      button.setAttribute("aria-pressed", String(index === selected));
    }
  }

  append(group);
  // Watch new views as well as the srcdoc load in each existing view.
  const view = doc.defaultView;
  if (view) {
    const observer = new view.MutationObserver((records) => {
      if (
        records.some(({ addedNodes }) =>
          Array.from(addedNodes).some(
            (node) =>
              node?.nodeType === 1 &&
              ((node as Element).localName === "iframe" ||
                (node as Element).querySelector("iframe")),
          ),
        )
      )
        update();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    controller.signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    });
    view.addEventListener("unload", () => controller.abort(), {
      once: true,
      signal: controller.signal,
    });
  }
  update();
}
