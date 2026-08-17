import assert from "node:assert/strict";
import test from "node:test";
import {
  extractChangelogEntry,
  renderReleaseNotes,
} from "../.github/scripts/render-release-notes";

const changelog = `# 版本日志

## 未发布

## 1.4.5 - 2026-08-13

### 修复

- 修复示例问题。

### 调整

- 调整示例行为。

## 1.4.4 - 2026-08-12

### 修复

- 上一个版本。
`;

test("extracts only the requested structured changelog section", () => {
  assert.equal(
    extractChangelogEntry(changelog, "1.4.5"),
    "### 修复\n\n- 修复示例问题。\n\n### 调整\n\n- 调整示例行为。",
  );
});

test("renders linked version heading and hierarchical release sections", () => {
  const result = renderReleaseNotes(
    "# [**{{TAG}}**]({{RELEASE_URL}})\n\n## 更新内容\n\n{{CHANGELOG_ENTRY}}\n\n## 完整记录\n\n{{CHANGELOG_URL}}",
    changelog,
    "1.4.5",
    "Woif-sha/paper-translate-for-zotero",
  );

  assert.match(
    result,
    /^# \[\*\*v1\.4\.5\*\*\]\(https:\/\/github\.com\/Woif-sha\/paper-translate-for-zotero\/releases\/tag\/v1\.4\.5\)$/mu,
  );
  assert.match(result, /^## 更新内容$/mu);
  assert.match(result, /^### 修复$/mu);
  assert.doesNotMatch(result, /上一个版本/u);
  assert.doesNotMatch(result, /\{\{[A-Z_]+\}\}/u);
});

test("rejects a missing or unstructured changelog section", () => {
  assert.throws(
    () => extractChangelogEntry(changelog, "1.4.6"),
    /no release section/u,
  );
  assert.throws(
    () =>
      extractChangelogEntry(
        "## 1.4.5 - 2026-08-13\n\n- 没有三级标题。\n",
        "1.4.5",
      ),
    /level-3 sections/u,
  );
});

test("renders changelog dollar notation as literal release-note text", () => {
  const result = renderReleaseNotes(
    "## 更新内容\n\n{{CHANGELOG_ENTRY}}\n\n## 完整记录",
    "## 1.4.7 - 2026-08-17\n\n### 修复\n\n- 修复 `$A′ = PA$` 的显示。\n",
    "1.4.7",
    "Woif-sha/paper-translate-for-zotero",
  );

  assert.equal(result.match(/^## 更新内容$/gmu)?.length, 1);
  assert.match(result, /`\$A′ = PA\$`/u);
});
