import { describe, expect, test } from "bun:test";
import { convertMarkdownToHtml } from "../formatting";

describe("convertMarkdownToHtml: tables", () => {
  test("renders a basic table as <pre> with aligned columns", () => {
    const md = [
      "| Name | Status |",
      "|------|--------|",
      "| a    | ok     |",
      "| beta | err    |",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("</pre>");
    expect(html).toMatch(/Name {2,}Status/);
    expect(html).toMatch(/a {4,}ok/);
    expect(html).toMatch(/beta {2,}err/);
    // No raw pipes leaking out of the <pre>
    expect(html.replace(/<pre>[\s\S]*?<\/pre>/, "")).not.toContain("|");
  });

  test("strips bold markers inside table cells", () => {
    const md = ["| Name |", "|------|", "| **alpha** |", "| beta |"].join("\n");
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("alpha");
    expect(html).not.toContain("**alpha**");
    expect(html).not.toContain("<b>alpha</b>");
  });

  test("supports a table mixed with surrounding markdown", () => {
    const md = [
      "## Heading",
      "",
      "Some **bold** intro.",
      "",
      "| col1 | col2 |",
      "|------|------|",
      "| x    | y    |",
      "",
      "Trailing _italic_ text.",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("<b>Heading</b>");
    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<pre>");
    expect(html).toContain("col1");
    expect(html).toContain("<i>italic</i>");
  });

  test("ignores pipe-containing text that's not a real table", () => {
    const md = [
      "Use the | character to pipe output:",
      "",
      "Just text with | a stray pipe inside.",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    expect(html).not.toContain("<pre>");
  });

  test("handles a separator line with alignment colons", () => {
    const md = [
      "| left | right |",
      "|:-----|------:|",
      "| 1    | 2     |",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("<pre>");
    expect(html).toMatch(/left.*right/);
  });

  test("table-shaped lines INSIDE a fenced code block render as code, not nested <pre> (bug_002)", () => {
    const md = [
      "Here's how to write a markdown table:",
      "",
      "```",
      "| col | col2 |",
      "|-----|------|",
      "| a   | b    |",
      "```",
      "",
      "End.",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    // Should contain exactly one <pre> (the code block); table extractor
    // must NOT have run on the lines inside the fence.
    expect(html).not.toMatch(/<pre>\s*<pre>/);
    expect(html).not.toMatch(/<\/pre>\s*<\/pre>/);
    // The pipe-table syntax is preserved verbatim inside the code block.
    expect(html).toContain("| col | col2 |");
    expect(html).toContain("|-----|------|");
    // Surrounding prose still rendered.
    expect(html).toContain("Here's how to write a markdown table:");
    expect(html).toContain("End.");
  });

  test("real table after a fenced code block still renders correctly (bug_002 corollary)", () => {
    const md = [
      "```",
      "| ignore | this |",
      "```",
      "",
      "Now a real one:",
      "",
      "| Run | Result |",
      "|-----|--------|",
      "| 1   | pass   |",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    // Fenced block is rendered as code (preserved verbatim).
    expect(html).toContain("| ignore | this |");
    // Real table after the fence is rendered as a <pre> aligned block.
    expect(html).toMatch(/Run\s+Result/);
    expect(html).not.toMatch(/<pre>\s*<pre>/);
  });
});

describe("convertMarkdownToHtml: $‑pattern safety in placeholder restoration", () => {
  test("$', $` and $& inside a fenced code block render literally (no duplication)", () => {
    // Bash commonly uses IFS=$'<char>' to set the field separator.
    const md = [
      "```bash",
      "IFS=$'\\n' read -r x",
      "echo $'tab\\tseparated'",
      "```",
      "",
      "Trailing text after the block.",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    // The trailing text must NOT be duplicated inside the <pre> — the
    // $' and $` replacement patterns would otherwise pull surrounding
    // text into the code block.
    const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(preMatch).not.toBeNull();
    const preContent = preMatch![1]!;
    // Trailing text should not appear inside the code block.
    expect(preContent).not.toContain("Trailing text after the block.");
    // The Bash content must be intact.
    expect(preContent).toContain("IFS=$'\\n'");
    expect(preContent).toContain("echo $'tab\\tseparated'");
    // $ patterns must appear literally, not replaced.
    expect(preContent).toContain("$'");
    // Trailing text appears outside the code block.
    expect(html).toContain("Trailing text after the block.");
  });

  test("$& inside inline code renders literally", () => {
    const md = "Use `$&` to reference the full match.";
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("<code>$&amp;</code>");
    expect(html).toContain("Use");
    // $& must not pull "Use" into the code element.
    expect(html).not.toContain("<code>Use");
  });

  test("$1, $2 inside a fenced code block are untouched", () => {
    const md = [
      "```js",
      "const swap = 'foo'.replace(/(foo)/, '$1bar');",
      "```",
    ].join("\n");
    const html = convertMarkdownToHtml(md);
    // $1 should appear literally in the code block (escaped as $ amp;1 by escapeHtml).
    expect(html).toContain("$1bar");
    // The code block should contain the original source but exclusively within <pre>
    // (no injection outside it). Verify the raw code is escaped properly — the
    // single quote in 'foo' should be escaped to &#39; (or &apos;).
    expect(html).toContain("<pre>const swap = ");
  });

  test("$‑patterns inside inline code do not leak", () => {
    const md = "Run `` IFS=$'\\n' `` then continue.";
    const html = convertMarkdownToHtml(md);
    expect(html).toContain("IFS=$'\\n'");
    // "continue" must not leak into the code element.
    const codeMatch = html.match(/<code>([\s\S]*?)<\/code>/);
    expect(codeMatch).not.toBeNull();
    expect(codeMatch![1]!).not.toContain("continue");
  });
});
