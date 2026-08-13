import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export function extractChangelogEntry(
  changelog: string,
  version: string,
): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid stable version: ${version}`);
  }
  const escapedVersion = version.replaceAll(".", "\\.");
  const match = changelog.match(
    new RegExp(
      `(?:^|\\r?\\n)## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`,
      "u",
    ),
  );
  const entry = match?.[1].trim();
  if (!entry) {
    throw new Error(`CHANGELOG.md has no release section for ${version}`);
  }
  if (!entry.startsWith("### ")) {
    throw new Error(`The ${version} changelog entry must use level-3 sections`);
  }
  return entry;
}

export function renderReleaseNotes(
  template: string,
  changelog: string,
  version: string,
  repository: string,
): string {
  if (!/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  const tag = `v${version}`;
  const repositoryUrl = `https://github.com/${repository}`;
  const replacements = new Map([
    ["{{TAG}}", tag],
    ["{{RELEASE_URL}}", `${repositoryUrl}/releases/tag/${tag}`],
    ["{{CHANGELOG_ENTRY}}", extractChangelogEntry(changelog, version)],
    ["{{CHANGELOG_URL}}", `${repositoryUrl}/blob/main/CHANGELOG.md`],
  ]);
  let result = template;
  for (const [placeholder, value] of replacements) {
    result = result.replaceAll(placeholder, value);
  }
  const unresolved = result.match(/\{\{[A-Z_]+\}\}/gu);
  if (unresolved) {
    throw new Error(`Unresolved release-note placeholder: ${unresolved[0]}`);
  }
  return `${result.trim()}\n`;
}

async function main(): Promise<void> {
  const [version, repository, outputPath] = process.argv.slice(2);
  if (!version || !repository || !outputPath) {
    throw new Error(
      "Usage: render-release-notes.ts <version> <owner/repository> <output>",
    );
  }
  const [template, changelog] = await Promise.all([
    readFile(".github/release-notes-template.md", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
  ]);
  await writeFile(
    outputPath,
    renderReleaseNotes(template, changelog, version, repository),
    "utf8",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
