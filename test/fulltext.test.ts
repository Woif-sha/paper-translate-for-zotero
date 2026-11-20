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
import { resolveFulltextFigures } from "../src/fulltext/assets";
import { translateFulltextUnits } from "../src/fulltext/translation";
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

test("cache figure placement uses only explicit unambiguous offsets", () => {
  const path = "images/f1.png";
  const manifest = {
    allFigures: [{ path, label: "Figure 1" }],
    figureBlocks: [{ imagePaths: [path], markdownStart: 6 }],
  };
  assert.deepEqual(resolveFulltextFigures(manifest as never, "hello\nworld"), [
    { path, label: "Figure 1", line: 1 },
  ]);
  manifest.figureBlocks.push({ imagePaths: [path], markdownStart: 0 });
  assert.equal(
    resolveFulltextFigures(manifest as never, "hello\nworld")[0].line,
    undefined,
  );
});

test("validated source to Zotero attachment, pause/resume and cache reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-translate-fulltext-"));
  const sourceDir = join(root, "llm-for-zotero-mineru", "10");
  const parent = {
    id: 5,
    key: parentKey,
    libraryID: 1,
    getField: (field: string) => (field === "title" ? "Beam mechanics" : ""),
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
  let imports = 0;
  let requests = 0;
  let outputPath = "";
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
        }) {
          assert.equal(input.parentItemID, 5);
          assert.equal(input.contentType, "text/html");
          imports++;
          outputPath = join(root, "storage", "OUTPUT12", basename(input.file));
          await mkdir(dirname(outputPath), { recursive: true });
          await copyFile(input.file, outputPath);
          const item = {
            id: 20,
            attachmentLinkMode: 0,
            attachmentContentType: "text/html",
            attachmentFilename: basename(outputPath),
            getFilePathAsync: async () => outputPath,
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
      readUTF8: (file: string) => readFile(file, "utf8"),
      async writeUTF8(
        path: string,
        value: string,
        options: { tmpPath: string },
      ) {
        await writeFile(options.tmpPath, value);
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
    await assert.rejects(
      startFulltext(10, (status) => {
        if (status.done) pauseFulltext(10);
      }),
      /暂停/u,
    );
    assert.equal(requests, 1);
    assert.equal(imports, 0);
    const output = await startFulltext(10, () => {});
    assert.equal(output.id, 20);
    assert.equal(requests, Math.ceil(parseFulltext(body).units.length / 6));
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /data:image\/png;base64,/u);
    assert.match(html, /中文译文/u);
    const checkpoints = await readdir(
      join(root, "paper-translate-for-zotero-fulltext", "1-" + sourceKey),
    );
    const checkpoint = checkpoints.find((name) => name.startsWith("blocks-"))!;
    assert.ok(checkpoint);
    assert.doesNotMatch(
      await readFile(
        join(
          root,
          "paper-translate-for-zotero-fulltext",
          "1-" + sourceKey,
          checkpoint,
        ),
        "utf8",
      ),
      /private-fixture-key/u,
    );
    const count = requests;
    assert.equal((await startFulltext(10, () => {})).id, 20);
    assert.equal(imports, 1);
    assert.equal(requests, count);
    assert.deepEqual(
      await readFile(join(sourceDir, "images", "plot.png")),
      png,
    );
    assert.equal(await readFile(join(sourceDir, "full.md"), "utf8"), body);
    assert.equal(existsSync(join(root, "paper-translate-for-zotero")), false);
  } finally {
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
