import assert from "node:assert/strict";
import test from "node:test";
import { validateContextDeletionTarget } from "../src/context/runtime";

test("accepts a matching paper context deletion target", () => {
  assert.doesNotThrow(() =>
    validateContextDeletionTarget(
      "E:\\ZoteroData\\paper-translate-for-zotero",
      "E:\\ZoteroData\\paper-translate-for-zotero\\AB12CD34",
      { parentItemKey: "AB12CD34" },
    ),
  );
});

test("rejects deletion outside the context root", () => {
  assert.throws(
    () =>
      validateContextDeletionTarget(
        "E:\\ZoteroData\\paper-translate-for-zotero",
        "E:\\ZoteroData\\other\\AB12CD34",
        { parentItemKey: "AB12CD34" },
      ),
    /escapes paper context root/,
  );
});

test("rejects a traversal path that only has the right textual prefix", () => {
  assert.throws(
    () =>
      validateContextDeletionTarget(
        "E:\\ZoteroData\\paper-translate-for-zotero",
        "E:\\ZoteroData\\paper-translate-for-zotero\\..\\other\\AB12CD34",
        { parentItemKey: "AB12CD34" },
      ),
    /escapes paper context root/,
  );
});

test("rejects a source record that disagrees with its folder", () => {
  assert.throws(
    () =>
      validateContextDeletionTarget(
        "E:\\ZoteroData\\paper-translate-for-zotero",
        "E:\\ZoteroData\\paper-translate-for-zotero\\AB12CD34",
        { parentItemKey: "ZX98YU76" },
      ),
    /identity mismatch/,
  );
});
