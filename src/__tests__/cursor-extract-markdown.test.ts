import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";
import {
  extractMarkdown,
  MARKDOWN_HELPERS_SOURCE,
} from "../cursor/composer-io";

function render(html: string): Element {
  const { document } = parseHTML(
    `<!doctype html><html><body><div>${html}</div></body></html>`,
  );
  return document.querySelector("body > div") as unknown as Element;
}

describe("extractMarkdown", () => {
  it("returns empty string for null input", () => {
    expect(extractMarkdown(null)).toBe("");
  });

  it("preserves plain prose with paragraph spacing", () => {
    const root = render("<p>Hello world.</p><p>Second paragraph.</p>");
    expect(extractMarkdown(root)).toBe("Hello world.\n\nSecond paragraph.");
  });

  it("renders tables as pipe-separated markdown with header separator", () => {
    const root = render(`
      <table>
        <thead><tr><th>Run</th><th>Result</th></tr></thead>
        <tbody>
          <tr><td>1st</td><td>Failed</td></tr>
          <tr><td>2nd</td><td>Passed</td></tr>
        </tbody>
      </table>
    `);
    const md = extractMarkdown(root);
    expect(md).toContain("| Run | Result |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1st | Failed |");
    expect(md).toContain("| 2nd | Passed |");
    // No mash-up like "RunResult1stFailed"
    expect(md).not.toContain("RunResult");
  });

  it("escapes raw pipes inside table cells", () => {
    const root = render(`
      <table>
        <tr><th>Cmd</th></tr>
        <tr><td>a | b</td></tr>
      </table>
    `);
    expect(extractMarkdown(root)).toContain("| a \\| b |");
  });

  it("renders pre+code as a fenced block", () => {
    const root = render(`<pre><code>const x = 1;\nconst y = 2;</code></pre>`);
    const md = extractMarkdown(root);
    expect(md).toContain("```\nconst x = 1;\nconst y = 2;\n```");
  });

  it("renders inline code with backticks", () => {
    const root = render("<p>Use <code>bun run test</code> to run tests.</p>");
    expect(extractMarkdown(root)).toContain("`bun run test`");
  });

  it("does not double-emit the inner code of a pre>code block as inline", () => {
    const root = render(`<pre><code>let z = 3;</code></pre>`);
    const md = extractMarkdown(root);
    // Only the fenced block, no extra `let z = 3;` inline rendition.
    expect(md.match(/let z = 3;/g)?.length).toBe(1);
  });

  it("renders bold and italic", () => {
    const root = render(
      "<p>This is <strong>bold</strong> and <em>italic</em>.</p>",
    );
    const md = extractMarkdown(root);
    expect(md).toContain("**bold**");
    expect(md).toContain("*italic*");
  });

  it("renders links with href", () => {
    const root = render(
      `<p>See <a href="https://example.com">the docs</a>.</p>`,
    );
    expect(extractMarkdown(root)).toContain("[the docs](https://example.com)");
  });

  it("renders headings at the right level", () => {
    const root = render("<h1>Top</h1><h2>Sub</h2><h3>Subsub</h3>");
    const md = extractMarkdown(root);
    expect(md).toContain("# Top");
    expect(md).toContain("## Sub");
    expect(md).toContain("### Subsub");
  });

  it("renders unordered lists as dashes", () => {
    const root = render("<ul><li>one</li><li>two</li></ul>");
    const md = extractMarkdown(root);
    expect(md).toContain("- one");
    expect(md).toContain("- two");
  });

  it("renders blockquotes prefixed with > ", () => {
    const root = render("<blockquote>Quoted text\nsecond line</blockquote>");
    const md = extractMarkdown(root);
    expect(md).toMatch(/> Quoted text/);
  });

  it("collapses runs of 3+ blank lines to 2", () => {
    const root = render("<p>a</p><br><br><br><br><br><p>b</p>");
    expect(extractMarkdown(root)).not.toMatch(/\n\n\n/);
  });

  it("inlined source string parses + works under a vanilla Function ctor", () => {
    // The observer script template-strings MARKDOWN_HELPERS_SOURCE into
    // page-evaluated JS. Running the same string through a Function ctor
    // (no TS toolchain) catches the day someone adds a TS-only feature
    // to walk/walkChildren/renderTable/extractMarkdown that compiles
    // fine in tests but fails to parse in Cursor's webview.
    const factory = new Function(
      MARKDOWN_HELPERS_SOURCE +
        "; return { walk, walkChildren, renderTable, extractMarkdown };",
    ) as () => {
      extractMarkdown: (n: Element | null) => string;
    };
    const helpers = factory();
    const root = render(
      "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>",
    );
    const md = helpers.extractMarkdown(root);
    expect(md).toContain("| a |");
    expect(md).toContain("| 1 |");
  });

  it("composes a realistic AI reply (table + prose)", () => {
    const root = render(`
      <p>Here's what ran:</p>
      <p>Command: <code>bun run test</code></p>
      <table>
        <tr><th>Run</th><th>Result</th></tr>
        <tr><td>1st</td><td>Failed</td></tr>
        <tr><td>2nd</td><td>Passed</td></tr>
      </table>
      <p>So the suite is <strong>green on retry</strong>.</p>
    `);
    const md = extractMarkdown(root);
    // Order is preserved
    const idxIntro = md.indexOf("Here");
    const idxTable = md.indexOf("| Run | Result |");
    const idxOutro = md.indexOf("**green on retry**");
    expect(idxIntro).toBeGreaterThanOrEqual(0);
    expect(idxTable).toBeGreaterThan(idxIntro);
    expect(idxOutro).toBeGreaterThan(idxTable);
  });
});
