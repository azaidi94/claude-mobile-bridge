import { describe, expect, test } from "bun:test";
import {
  convertMarkdownToHtml,
  looksLikeTelegramHtml,
  sanitizeTelegramHtml,
} from "../formatting";

describe("looksLikeTelegramHtml", () => {
  test("detects bold tag pair", () => {
    expect(looksLikeTelegramHtml("hello <b>world</b>")).toBe(true);
  });

  test("detects pre block", () => {
    expect(looksLikeTelegramHtml("<pre>code\n  here</pre>")).toBe(true);
  });

  test("rejects plain text with stray <", () => {
    expect(looksLikeTelegramHtml("if x < 5 then go")).toBe(false);
  });

  test("rejects markdown with backticks", () => {
    expect(looksLikeTelegramHtml("the **foo** is `bar`")).toBe(false);
  });

  test("rejects unclosed tag", () => {
    expect(looksLikeTelegramHtml("<b>oops")).toBe(false);
  });

  test("rejects non-allowlist tag pair", () => {
    expect(looksLikeTelegramHtml("<div>hi</div>")).toBe(false);
  });
});

describe("sanitizeTelegramHtml", () => {
  test("keeps allowed tags verbatim", () => {
    expect(sanitizeTelegramHtml("<b>foo</b> <i>bar</i>")).toBe(
      "<b>foo</b> <i>bar</i>",
    );
  });

  test("escapes disallowed tags as text", () => {
    const out = sanitizeTelegramHtml("<div>x</div>");
    expect(out).toBe("&lt;div&gt;x&lt;/div&gt;");
  });

  test("escapes ampersands and angle brackets in text content", () => {
    const out = sanitizeTelegramHtml("<b>1 & 2 < 3</b>");
    expect(out).toBe("<b>1 &amp; 2 &lt; 3</b>");
  });

  test("preserves pre-escaped entities in text (no double-escape)", () => {
    // Hand-authored HTML with `&lt;path&gt;` must survive verbatim, not become
    // a literal `&lt;path&gt;` (which is `&amp;lt;…` on the wire).
    const out = sanitizeTelegramHtml("<b>Automation</b> /ralph &lt;path&gt;");
    expect(out).toBe("<b>Automation</b> /ralph &lt;path&gt;");
    expect(out).not.toContain("&amp;lt;");
  });

  test("raw & next to a non-entity word still escapes", () => {
    expect(sanitizeTelegramHtml("<b>AT&T</b>")).toBe("<b>AT&amp;T</b>");
  });

  test("preserves <pre> with newlines for code blocks", () => {
    const out = sanitizeTelegramHtml("<pre>line1\nline2</pre>");
    expect(out).toBe("<pre>line1\nline2</pre>");
  });

  test("keeps href on anchor, strips other attrs", () => {
    const out = sanitizeTelegramHtml(
      '<a href="https://x.com" target="_blank" onclick="evil()">link</a>',
    );
    expect(out).toBe('<a href="https://x.com">link</a>');
  });

  test("anchor without href is escaped", () => {
    const out = sanitizeTelegramHtml("<a>bare</a>");
    expect(out).toContain("&lt;a&gt;");
  });
});

describe("convertMarkdownToHtml: HTML passthrough", () => {
  test("HTML input is sanitized, not escaped", () => {
    const html = convertMarkdownToHtml(
      "<b>Heading</b>\n<pre>code\nblock</pre>",
    );
    expect(html).toContain("<b>Heading</b>");
    expect(html).toContain("<pre>code\nblock</pre>");
    expect(html).not.toContain("&lt;b&gt;");
  });

  test("markdown input still works (no regression)", () => {
    const out = convertMarkdownToHtml("**bold** and `code`");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<code>code</code>");
  });

  test("plain text with stray < is escaped (still routed as markdown)", () => {
    const out = convertMarkdownToHtml("if x < 5 then go");
    expect(out).toBe("if x &lt; 5 then go");
  });

  test("HTML containing a disallowed tag has it escaped, allowed tags kept", () => {
    const out = convertMarkdownToHtml("<b>safe</b> <script>alert(1)</script>");
    expect(out).toContain("<b>safe</b>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});
