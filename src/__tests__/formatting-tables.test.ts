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
});
