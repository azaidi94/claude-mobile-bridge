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
