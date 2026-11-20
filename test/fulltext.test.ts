import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  rename,
  copyFile,
  readdir,
} from "node:fs/promises";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readValidatedMineruSource } from "../src/context/runtime";
import {
  parseFulltext,
  renderFulltext,
  restoreTranslation,
} from "../src/fulltext/document";
import { pauseFulltext, startFulltext } from "../src/fulltext/job";
import { registerFulltextUI, unregisterFulltextUI } from "../src/fulltext/ui";
import { resolveFulltextFigures } from "../src/fulltext/assets";
import { translateFulltextUnits } from "../src/fulltext/translation";
import { appendFulltextReadingModes } from "../src/fulltext/readingModes";
import { setModelProviderConfiguration } from "../src/models/providers";
import type { RuntimeModel } from "../src/models/runtime";

const sourceKey = "PDFKEY12";
const parentKey = "PARENT12";
const sample = [
  "# Beam mechanics",
  "",
  "At 1 MPa, the deflection is \\(x^2\\) [1].",
  "",
  "![Original illustration](images/plot.png)",
  "",
  "Figure 1. A cantilever beam.",
  "",
  "- First item",
  "- Second item",
  "",
  "| Method | Peak |",
  "| --- | --- |",
  "| FEM | 1.2 |",
  "",
  '<table onmouseover="alert(1)"><tr><td colspan="2">Table body</td></tr></table>',
  "",
  "<script>alert(1)</script>",
  "",
  "## References",
  "",
  "A. Author (2026). Reference entry.",
].join("\n");

function simulatedTranslation(text: string): string {
  return (
    "中文译文" +
    [...text.matchAll(/⟦PT:\d+⟧/gu)].map((match) => " " + match[0]).join("")
  );
}

test("full-paper HTML preserves structure, uses safe MathML and isolates untrusted markup", () => {
  const document = parseFulltext(sample);
  assert.ok(
    document.units.some((unit) => unit.protectedParts.includes("\\(x^2\\)")),
  );
  assert.ok(
    document.units.some((unit) => unit.protectedParts.includes("1 MPa")),
  );
  assert.ok(document.units.some((unit) => unit.protectedParts.includes("[1]")));
  assert.ok(
    !document.units.some((unit) =>
      /Reference entry|Table body/u.test(unit.text),
    ),
  );
  const assets = new Map([
    ["images/plot.png", "data:image/png;base64,iVBORw0KGgo="],
  ]);
  const html = renderFulltext(
    document,
    new Map(
      document.units.map((unit) => [unit.id, simulatedTranslation(unit.text)]),
    ),
    {
      assets,
      title: "<paper>",
      model: "Test <model>",
      figures: [{ path: "images/missing.png", label: "Fig. 2" }],
    },
  );
  const view = new JSDOM(html);
  try {
    const dom = view.window.document;
    assert.equal(dom.title, "<paper>");
    assert.equal(dom.querySelectorAll("script,[onmouseover]").length, 0);
    assert.equal(dom.querySelectorAll("table").length, 2);
    assert.equal(
      dom.querySelector("td[colspan]")?.getAttribute("colspan"),
      "2",
    );
    assert.equal(dom.querySelectorAll("math").length, 2);
    assert.match(dom.querySelector(".missing")?.textContent ?? "", /Fig. 2/u);
    assert.equal(dom.querySelectorAll('input[type="radio"]').length, 3);
    assert.equal(
      dom.querySelector("img")?.getAttribute("src"),
      assets.get("images/plot.png"),
    );
    assert.match(
      dom.querySelector("main")?.textContent ?? "",
      /Reference entry/u,
    );
    assert.match(dom.querySelector(".zh")?.textContent ?? "", /中文译文/u);
  } finally {
    view.window.close();
  }
});

test("switches the reading mode from the Zotero toolbar", () => {
  const view = new JSDOM("<div id=toolbar></div><iframe></iframe>");
  try {
    const doc = view.window.document;
    const toolbar = doc.querySelector("#toolbar")!;
    const frame = doc.querySelector("iframe")!;
    let refreshes = 0;
    appendFulltextReadingModes(
      doc,
      (group) => {
        toolbar.append(group);
        assert.deepEqual(
          Array.from(toolbar.querySelectorAll("button"), (button) =>
            button.getAttribute("aria-pressed"),
          ),
          ["true", "false", "false"],
        );
        assert.equal(toolbar.querySelector(".active")?.textContent, "双语");
      },
      () => refreshes++,
    );
    const buttons = Array.from(toolbar.querySelectorAll("button"));
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ["双语", "中文", "原文"],
    );
    buttons[1].click();
    const body = frame.contentDocument!.body;
    body.innerHTML =
      '<nav id="fulltext-reading-modes" hidden>' +
      '<input id="mode-bi" type="radio" name="mode" checked><input id="mode-zh" type="radio" name="mode">' +
      '<input id="mode-en" type="radio" name="mode"></nav><main><section data-block-id="1"><div class="en"><h1>Paper title</h1></div><div class="zh"><h1>论文标题</h1></div></section></main>';
    frame.dispatchEvent(new view.window.Event("load"));
    assert.equal(body.querySelector("input:checked")?.id, "mode-zh");
    assert.equal(body.querySelector("main h1")?.textContent, "Paper title");
    assert.ok(body.querySelector<HTMLElement>("nav")?.hidden);
    for (const [index, id] of ["mode-zh", "mode-en", "mode-bi"].entries()) {
      const button = buttons[(index + 1) % buttons.length];
      button.click();
      assert.equal(body.querySelector("input:checked")?.id, id);
      assert.equal(button.getAttribute("aria-pressed"), "true");
      const en = body.querySelector(".en h1")!;
      const zh = body.querySelector(".zh h1")!;
      assert.equal(en.hasAttribute("hidden"), id === "mode-zh");
      assert.equal(zh.hasAttribute("hidden"), id === "mode-en");
    }
    assert.equal(refreshes, 4);
  } finally {
    view.window.close();
  }
});

test("keeps front-page authors, affiliation and email out of translation but retains them in all views", () => {
  const source = [
    "# A Numerical Study",
    "Alice Smith <sup>1</sup>, Bob Lee <sup>2</sup>",
    "<sup>1</sup>Example Research Institute",
    "{alice.smith,bob.lee}@example.org",
    "We study the beam response.",
    "## Abstract",
    "Alice Smith and Bob Lee contributed to this study.",
  ].join("\n\n");
  const parsed = parseFulltext(source);
  assert.deepEqual(
    parsed.units.map((unit) => unit.text),
    [
      "A Numerical Study",
      "We study the beam response.",
      "Abstract",
      "Alice Smith and Bob Lee contributed to this study.",
    ],
  );
  const html = renderFulltext(
    parsed,
    new Map(parsed.units.map((unit) => [unit.id, "中文"])),
    {
      assets: new Map(),
      title: "Fixture",
      model: "Test",
    },
  );
  assert.match(html, /Alice Smith <sup>1<\/sup>, Bob Lee <sup>2<\/sup>/u);
  assert.match(html, /alice\.smith,bob\.lee\}@example\.org/u);
});

test("damaged structured response falls back and persists successful individual units", async () => {
  const units = parseFulltext(
    "The result is 2.5 MPa.\n\nA second test at 10 mm.",
  ).units;
  assert.throws(() => restoreTranslation(units[0], "译文"), /标记/u);
  assert.throws(
    () => restoreTranslation(units[0], "译文 ⟦PT:0⟧ ⟦PT:0⟧"),
    /标记/u,
  );
  const checkpointSizes: number[] = [];
  let calls = 0;
  const model = { authMode: "codex_auth", model: "mock" } as RuntimeModel;
  const output = await translateFulltextUnits({
    units,
    checkpoint: {},
    model,
    signal: new AbortController().signal,
    async save(results) {
      checkpointSizes.push(results.size);
    },
    progress() {},
    async request({ prompt }, snapshot) {
      assert.equal(snapshot, model);
      const text =
        calls++ === 0
          ? '[{"id":"unknown","text":"错误"}]'
          : simulatedTranslation(prompt);
      return { text, webSearchCalls: 0, urlCitations: [] };
    },
  });
  assert.equal(calls, 3);
  assert.equal(output.size, 2);
  assert.deepEqual(checkpointSizes, [1, 2]);
});

test("uses simpler markers when a model drops the original notation", async () => {
  const [unit] = parseFulltext("The beam carries 2 MPa.").units;
  const replies = ["not JSON", "梁承受压力。", "梁承受 [[PT_0]] 的压力。"];
  const results = await translateFulltextUnits({
    units: [unit],
    checkpoint: {},
    model: {} as RuntimeModel,
    signal: new AbortController().signal,
    async save() {},
    progress() {},
    async request({ prompt, instructions }) {
      if (replies.length === 1) {
        assert.match(prompt, /\[\[PT_0\]\]/u);
        assert.match(instructions ?? "", /\[\[PT_n\]\]/u);
      }
      return { text: replies.shift()!, webSearchCalls: 0, urlCitations: [] };
    },
  });
  assert.equal(
    restoreTranslation(unit, results.get(unit.id)!),
    "梁承受 2 MPa 的压力。",
  );
  assert.equal(replies.length, 0);
  await assert.rejects(
    translateFulltextUnits({
      units: [unit],
      checkpoint: {},
      model: {} as RuntimeModel,
      signal: new AbortController().signal,
      async save() {},
      progress() {},
      async request() {
        return { text: "No translation.", webSearchCalls: 0, urlCitations: [] };
      },
    }),
    new RegExp("段落 " + unit.id + "：模型遗漏或改写"),
  );
});

test("rebuilds a translation around intact source literals when a model drops markers", async () => {
  const [unit] = parseFulltext(
    "Load equals 5 MPa for 2D-Burger’s, 3 test runs followed.",
  ).units;
  const responses = [
    "invalid batch",
    "载荷已知",
    "载荷已知",
    "载荷等于",
    "用于",
    "D-Burger’s，",
    "次试验随后完成。",
  ];
  const result = await translateFulltextUnits({
    units: [unit],
    checkpoint: {},
    model: {} as RuntimeModel,
    signal: new AbortController().signal,
    progress() {},
    async save() {},
    async request({ prompt }) {
      if (responses.length <= 4) assert.doesNotMatch(prompt, /MPa|⟦|\[\[PT_/u);
      return { text: responses.shift()!, webSearchCalls: 0, urlCitations: [] };
    },
  });
  assert.equal(
    restoreTranslation(unit, result.get(unit.id)!),
    "载荷等于 5 MPa 用于 2D-Burger’s, 3 次试验随后完成。",
  );
  assert.equal(responses.length, 0);
});

test("includes chart panels outside allFigures and anchors groups to verified captions", () => {
  const first = "images/f1.png";
  const panelA = "images/chart-a.png";
  const panelB = "images/chart-b.png";
  const unplaced = "images/unplaced.png";
  const manifest = {
    allFigures: [{ path: first, label: "Figure 1" }],
    figureBlocks: [
      {
        imagePaths: [first],
        labelHints: ["Figure 1"],
        markdownStart: 0,
        contextEnd: 10,
      },
      { imagePaths: [panelA], markdownStart: 90, contextEnd: 100 },
      {
        imagePaths: [panelB],
        labelHints: ["Figure 2"],
        markdownStart: 101,
        contextEnd: 115,
      },
      { imagePaths: [unplaced], labelHints: ["Figure 3"], markdownStart: 0 },
    ],
  };
  const markdown =
    "Intro\nFigure 1: Architecture\n\nFigure 2: Results\n\nConclusion";
  assert.deepEqual(resolveFulltextFigures(manifest as never, markdown), [
    { path: first, label: "Figure 1", line: 1 },
    { path: panelA, label: "Figure 2", line: 3 },
    { path: panelB, label: "Figure 2", line: 3 },
    { path: unplaced, label: "Figure 3" },
  ]);
});

test("places case-insensitive pipe captions and splits multipanel ranges by the content list", () => {
  const paths = [
    "images/a.png",
    "images/b.png",
    "images/c.png",
    "images/d.png",
    "images/b1.png",
  ];
  const caption8 = "FIGURE 8 | Scores";
  const caption9 = "FIGURE 9 | A second experiment";
  const appendix = "FIGURE B1 | Supplementary results";
  const md = [
    "Figure 8 shows the results in the text.",
    "(A)\n" + caption8,
    caption9,
    appendix,
  ].join("\n\n");
  const manifest = {
    figureBlocks: [
      {
        imagePaths: paths,
        labelHints: ["Figure 8", "Figure 9"],
        markdownStart: 990,
      },
    ],
  };
  const content = [
    { type: "chart", img_path: paths[0], page_idx: 8, bbox: [10, 15, 40, 100] },
    { type: "text", text: "A paragraph between columns" },
    {
      type: "chart",
      img_path: paths[1],
      page_idx: 8,
      bbox: [50, 15, 90, 100],
      chart_caption: [caption8],
    },
    { type: "chart", img_path: paths[2], page_idx: 9 },
    {
      type: "chart",
      img_path: paths[3],
      page_idx: 9,
      chart_caption: [caption9],
    },
    {
      type: "image",
      img_path: paths[4],
      page_idx: 22,
      image_caption: [appendix],
    },
  ];
  const figures = resolveFulltextFigures(manifest as never, md, content);
  assert.deepEqual(
    figures.map(({ path, line }) => [path, line]),
    paths.map((path, i) => [path, [3, 3, 5, 5, 7][i]]),
  );
  const paper = parseFulltext(md);
  const rows = new Map(
    paper.units.map((unit) => [unit.id, simulatedTranslation(unit.text)]),
  );
  const images = new Map(
    paths.map((path) => [path, "data:image/png;base64,AA=="]),
  );
  const view = new JSDOM(
    renderFulltext(paper, rows, {
      title: "Fixture",
      model: "Test",
      assets: images,
      figures,
    }),
  );
  try {
    const main = view.window.document.querySelector("main")!;
    const sections = main.querySelectorAll("section");
    for (const [index, label] of [
      "Figure 8",
      "Figure 9",
      "Figure B1",
    ].entries()) {
      assert.equal(
        sections[index + 1].previousElementSibling?.querySelector("img")?.alt,
        label,
      );
    }
    assert.equal(main.querySelectorAll("aside").length, 0);
  } finally {
    view.window.close();
  }
});

test("validated source to Zotero attachment, pause/resume and cache reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-translate-fulltext-"));
  const sourceDir = join(root, "llm-for-zotero-mineru", "10");
  const parent = {
    id: 5,
    key: parentKey,
    libraryID: 1,
    getField: (field: string) =>
      field === "title" ? "Beam mechanics in layered elastic media" : "",
    isAttachment: () => false,
    isRegularItem: () => true,
    isEditable: () => true,
    getAttachments: () => (items.has(20) ? [10, 20] : [10]),
  };
  const pdf = {
    id: 10,
    key: sourceKey,
    libraryID: 1,
    parentItemID: 5,
    isAttachment: () => true,
    isPDFAttachment: () => true,
  };
  const items = new Map<number, unknown>([
    [5, parent],
    [10, pdf],
  ]);
  const prefs = new Map();
  const globals = globalThis as Record<string, any>;
  const before = new Map(
    ["Zotero", "IOUtils", "ztoolkit"].map((key) => [key, globals[key]]),
  );
  let registeredMenu:
    | _ZoteroTypes.MenuManager.MenuOptions<"main/library/item">
    | undefined;
  const assertCommands = (expected: boolean[]) => {
    const menu = registeredMenu?.menus[0].menus;
    assert.ok(menu);
    const states: boolean[] = [];
    const context = {
      items: [pdf],
      setEnabled: (enabled: boolean) => states.push(enabled),
    };
    for (const command of menu) {
      command.onShowing?.(
        new Event("popupshowing"),
        context as unknown as _ZoteroTypes.MenuManager.LibraryMenuContext,
      );
    }
    assert.deepEqual(states, expected);
  };
  let imports = 0;
  let requests = 0;
  let outputPath = "";
  let outputTitle = "";
  let titleSaves = 0;
  let blockedWrites = 0;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    const body = sample.replace(
      "## References",
      Array.from({ length: 8 }, (_, i) => "Sample paragraph " + i + ".").join(
        "\n\n",
      ) + "\n\n## References",
    );
    await mkdir(join(sourceDir, "images"), { recursive: true });
    await writeFile(join(sourceDir, "images", "plot.png"), png);
    await writeFile(join(sourceDir, "full.md"), body);
    await writeFile(
      join(sourceDir, "manifest.json"),
      JSON.stringify({ totalChars: body.length }),
    );
    const provenancePath = join(sourceDir, "_llm_source.json");
    const provenance = {
      kind: "llm-for-zotero/mineru-cache-source",
      version: 2,
      attachmentId: 10,
      parentItemKey: parentKey,
      attachmentKey: sourceKey,
      origin: "parsed",
      recordedAt: "2026-11-20",
    };
    await writeFile(
      provenancePath,
      JSON.stringify({ ...provenance, attachmentKey: "WRONGKEY" }),
    );
    globals.Zotero = {
      DataDirectory: { dir: root },
      MenuManager: {
        registerMenu: (menu: typeof registeredMenu) => {
          registeredMenu = menu;
        },
        unregisterMenu() {},
      },
      Reader: { registerEventListener() {}, unregisterEventListener() {} },
      Items: {
        get: (id: number | number[]) =>
          Array.isArray(id)
            ? id.map((n) => items.get(n))
            : (items.get(id) ?? false),
      },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      File: { pathToFile: makeRuntimeFile },
      Attachments: {
        LINK_MODE_IMPORTED_FILE: 0,
        getStorageDirectory: () => ({ path: dirname(outputPath) }),
        async importFromFile(input: {
          file: string;
          parentItemID: number;
          contentType: string;
          title: string;
        }) {
          assert.equal(input.parentItemID, 5);
          assert.equal(input.contentType, "text/html");
          imports++;
          outputTitle = input.title;
          outputPath = join(root, "storage", "OUTPUT12", basename(input.file));
          await mkdir(dirname(outputPath), { recursive: true });
          await copyFile(input.file, outputPath);
          const item = {
            id: 20,
            parentItemID: input.parentItemID,
            attachmentLinkMode: 0,
            attachmentContentType: "text/html",
            attachmentFilename: basename(outputPath),
            getFilePathAsync: async () => outputPath,
            getField: () => outputTitle,
            setField: (_field: string, title: string) => {
              outputTitle = title;
            },
            saveTx: async () => {
              titleSaves++;
            },
          };
          items.set(20, item);
          return item;
        },
      },
    };
    globals.IOUtils = {
      exists: async (file: string) => existsSync(file),
      stat: async (file: string) => {
        const info = await stat(file);
        return {
          type: info.isFile() ? "regular" : "directory",
          size: info.size,
        };
      },
      read: async (file: string, options?: { maxBytes: number }) =>
        (await readFile(file)).subarray(0, options?.maxBytes),
      getChildren: async (directory: string) =>
        (await readdir(directory)).map((name) => join(directory, name)),
      async write(
        path: string,
        value: Uint8Array,
        options: { tmpPath: string },
      ) {
        await writeFile(options.tmpPath, value);
        await rename(options.tmpPath, path);
      },
      readUTF8: (file: string) => readFile(file, "utf8"),
      async writeUTF8(
        path: string,
        value: string,
        options: { tmpPath: string },
      ) {
        await writeFile(options.tmpPath, value);
        if (basename(path).startsWith("fulltext-") && !blockedWrites) {
          blockedWrites++;
          throw new DOMException("Access is denied", "NotAllowedError");
        }
        await rename(options.tmpPath, path);
      },
      makeDirectory: (path: string) => mkdir(path, { recursive: true }),
    };
    globals.ztoolkit = {
      getGlobal: () => async (url: string, init: RequestInit) => {
        assert.equal(url, "http://127.0.0.1:8518/v1/chat/completions");
        requests++;
        const payload = JSON.parse(init.body as string);
        const user = payload.messages.find(
          (message: any) => message.role === "user",
        ).content;
        const input = JSON.parse(user.slice(user.indexOf("\n") + 1));
        const text = JSON.stringify(
          input.map(({ id, text }: { id: string; text: string }) => ({
            id,
            text: simulatedTranslation(text),
          })),
        );
        return new Response(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: text }, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    };
    setModelProviderConfiguration(
      [
        {
          id: "provider",
          name: "Local fixture",
          authMode: "openai_compatible",
          apiBase: "http://127.0.0.1:8518/v1",
          apiKey: "private-fixture-key",
          models: [{ id: "m", model: "test-model", effort: "" }],
        },
      ],
      "m",
    );
    await assert.rejects(readValidatedMineruSource(10), /attachmentKey/u);
    await writeFile(provenancePath, JSON.stringify(provenance));
    registerFulltextUI();
    assertCommands([true, false]);
    let resumed: ReturnType<typeof startFulltext> | undefined;
    await assert.rejects(
      startFulltext(10, (status) => {
        if (!status.done) return;
        assertCommands([false, true]);
        pauseFulltext(10);
        assertCommands([true, false]);
        resumed = startFulltext(10, () => {});
      }),
      /暂停/u,
    );
    assert.equal(requests, 1);
    assert.equal(imports, 0);
    assert.ok(resumed);
    const output = await resumed;
    assertCommands([true, false]);
    assert.equal(output.id, 20);
    assert.equal(blockedWrites, 1);
    assert.equal(outputTitle, "Beam mechanics in layered elastic-Translate");
    assert.equal(requests, Math.ceil(parseFulltext(body).units.length / 6));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data:image\/png;base64,/u);
    assert.match(html, /中文译文/u);
    const context = join(root, "paper-translate-for-zotero", parentKey);
    const checkpoint = join(context, "fulltext-" + sourceKey + ".json");
    const raw = await readFile(checkpoint, "utf8");
    assert.doesNotMatch(raw, /private-fixture-key/u);
    const count = requests;
    outputTitle = "全文翻译 · 中英对照";
    assert.equal((await startFulltext(10, () => {})).id, 20);
    assert.equal(imports, 1);
    assert.equal(outputTitle, "Beam mechanics in layered elastic-Translate");
    assert.equal(titleSaves, 1);
    assert.equal(requests, count);
    assert.equal(await readFile(checkpoint, "utf8"), raw);
    assert.deepEqual(
      await readFile(join(sourceDir, "images", "plot.png")),
      png,
    );
    assert.equal(await readFile(join(sourceDir, "full.md"), "utf8"), body);
    assert.equal(
      JSON.parse(await readFile(join(context, "_paper_source.json"), "utf8"))
        .parentItemKey,
      parentKey,
    );
    assert.equal(
      await readFile(join(context, basename(outputPath)), "utf8"),
      html,
    );
  } finally {
    await unregisterFulltextUI();
    for (const [key, value] of before) globals[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

function makeRuntimeFile(initialPath: string): any {
  return {
    path: initialPath,
    normalize() {
      this.path = realpathSync(this.path);
    },
    isSymlink() {
      return lstatSync(this.path).isSymbolicLink();
    },
    equals(other: { path: string }) {
      return this.path === other.path;
    },
    get parent() {
      return makeRuntimeFile(dirname(this.path));
    },
  };
}
