import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReaderSelection } from "../src/modules/reader";
import { normalizeTaskText } from "../src/utils/task";

test("removes IEEE cross-page footer and access notice noise", () => {
  const selected = [
    "The key 979-8-3503-9354-5/24/$31.00 ©2024 IEEE 2D-1 171 2024 29th Asia and South Pacific Design Automation Conference (ASP-DAC) | 979-8-3503-9354-5/24/$31.00 ©2024 IEEE | DOI: 10.1109/ASP-DAC58780.2024.10473881 Authorized licensed use limited to: Southeast University. Downloaded on July 16, 2026 at 07:25:45 UTC from IEEE Xplore. Restrictions apply. is to remove",
    "redundant parasitic RC nodes from cell graph while maintain the dominant RC.",
  ].join("\n");
  assert.equal(
    normalizeReaderSelection(selected),
    "The key is to remove redundant parasitic RC nodes from cell graph while maintain the dominant RC.",
  );
});

test("task normalization retains paragraph and bullet line breaks", () => {
  assert.equal(
    normalizeTaskText("first\r\n\r\n• second\u0001"),
    "first\n\n• second",
  );
});

test("preserves bullet boundaries while joining visual line wraps", () => {
  const selected = [
    "• To the best of our knowledge, this is the first work to apply",
    "heterogeneous graph learning.",
    "• A statistical timing prediction framework is established based",
    "on HGAT.",
    "• The tremendous parasitic RC nodes are reduced efficiently.",
  ].join("\n");
  assert.equal(
    normalizeReaderSelection(selected),
    [
      "• To the best of our knowledge, this is the first work to apply heterogeneous graph learning.",
      "• A statistical timing prediction framework is established based on HGAT.",
      "• The tremendous parasitic RC nodes are reduced efficiently.",
    ].join("\n"),
  );
});

test("keeps an inline bullet operator inside a semantic line", () => {
  assert.equal(
    normalizeReaderSelection(
      "The similarity is defined as a • b\nfor each pair.",
    ),
    "The similarity is defined as a • b for each pair.",
  );
});

test("preserves formulas, standalone numeric content, and semantic hyphens", () => {
  assert.equal(
    normalizeReaderSelection(
      "The sample size was\n128\nwith m²/σ². A well-\nknown method uses x -\ny.",
    ),
    "The sample size was 128 with m²/σ². A well-known method uses x - y.",
  );
  assert.equal(normalizeTaskText("m²/σ²"), "m²/σ²");
});

test("does not remove a semantic restrictions sentence without IEEE furniture", () => {
  assert.equal(
    normalizeReaderSelection(
      "The following restrictions apply. The method remains valid.",
    ),
    "The following restrictions apply. The method remains valid.",
  );
});

test("never spans semantic text while removing separated IEEE furniture", () => {
  const selected = [
    "979-8-3503-9354-5/24/$31.00 ©2024 IEEE",
    "This semantic paragraph reports the measured timing improvement.",
    "Restrictions apply.",
  ].join("\n");
  const normalized = normalizeReaderSelection(selected);
  assert.match(
    normalized,
    /This semantic paragraph reports the measured timing improvement\./,
  );
});
