import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreparationRecord,
  migrateTerminologyMarkdown,
  updatePreparationStages,
} from "../src/context/runtime";

test("unlocks core translation before optional external research finishes", () => {
  const initial = createPreparationRecord(
    "ABCD1234",
    "hash",
    "2026-01-01T00:00:00Z",
  );
  const core = updatePreparationStages(
    initial,
    [
      { id: "source", status: "complete" },
      { id: "index", status: "complete" },
      { id: "background", status: "complete" },
      { id: "terminology", status: "complete" },
    ],
    "2026-01-01T00:01:00Z",
  );
  assert.equal(core.overall, "core-ready");
  const warning = updatePreparationStages(
    core,
    [{ id: "external", status: "warning", detail: "rate limited" }],
    "2026-01-01T00:02:00Z",
  );
  assert.equal(warning.overall, "ready");
});

test("migrates legacy terminology while preserving the human translation", () => {
  const migrated = migrateTerminologyMarkdown(
    [
      "# Terminology: Paper",
      "",
      "| Source | Translation | Evidence | Updated at |",
      "| --- | --- | --- | --- |",
      "| timing arc | 时序弧 | Methods | 2026-01-01 |",
      "",
    ].join("\n"),
    "Paper",
  );
  assert.match(migrated, /\| timing arc \| timing arc \| 时序弧 \| legacy \|/);
});

test("revalidates preserved terminology against an updated Markdown version", () => {
  const current = [
    "# Terminology: Paper",
    "",
    "| Observed expression | Canonical English | Preferred Chinese | Category | Definition | Paper evidence | Source level | Confidence | Updated at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| timing arc | timing arc | 人工译法 | EDA | relation | Method | paper | high | 2026-01-01 |",
    "| removed term | removed term | 旧译法 | EDA | old | Old | paper | high | 2026-01-01 |",
    "",
  ].join("\n");
  const migrated = migrateTerminologyMarkdown(
    current,
    "Paper",
    "# Method\nA timing arc is characterized.",
  );
  assert.match(migrated, /人工译法/);
  assert.doesNotMatch(migrated, /removed term/);
});
