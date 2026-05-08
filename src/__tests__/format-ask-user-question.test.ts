/**
 * Unit tests for formatAskUserQuestion — render-only Telegram card for
 * Claude's built-in AskUserQuestion tool.
 */

import { describe, expect, test } from "bun:test";
import { formatAskUserQuestion } from "../formatting";
import type { AskUserQuestionItem } from "../types";

describe("formatAskUserQuestion", () => {
  test("single question with two options", () => {
    const html = formatAskUserQuestion([
      {
        question: "Which database should we use?",
        options: [
          { label: "Postgres", description: "Full-featured" },
          { label: "SQLite", description: "Embedded" },
        ],
      },
    ]);
    expect(html).toContain("❓ <b>Claude is asking</b>");
    expect(html).toContain("<b>Q:</b> Which database should we use?");
    expect(html).toContain("• <b>Postgres</b> — Full-featured");
    expect(html).toContain("• <b>SQLite</b> — Embedded");
    expect(html).toContain("<i>Answer at the desktop.</i>");
    expect(html).not.toContain("(pick any)");
    expect(html).not.toContain("(card truncated");
  });

  test("includes header chip when present", () => {
    const html = formatAskUserQuestion([
      {
        question: "Pick a port",
        header: "Network",
        options: [{ label: "8080" }, { label: "3000" }],
      },
    ]);
    expect(html).toContain("<i>[Network]</i>");
  });

  test("multiSelect appends pick-any tag", () => {
    const html = formatAskUserQuestion([
      {
        question: "Which features?",
        multiSelect: true,
        options: [{ label: "Auth" }, { label: "Billing" }],
      },
    ]);
    expect(html).toContain("<b>Q:</b> Which features? <i>(pick any)</i>");
  });

  test("renders short preview as <pre>", () => {
    const preview = "+--------+\n| header |\n+--------+";
    const html = formatAskUserQuestion([
      {
        question: "Layout?",
        options: [{ label: "A", preview }, { label: "B" }],
      },
    ]);
    expect(html).toContain(`<pre>${preview}</pre>`);
  });

  test("caps escaped preview length even when raw input is HTML-special-heavy", () => {
    // 600 raw `<` would expand to 2400 chars after escaping (`&lt;` × 600).
    // The cap is on the *escaped* output, so we should see far fewer entities.
    const preview = "<".repeat(600);
    const html = formatAskUserQuestion([
      {
        question: "?",
        options: [{ label: "A", preview }, { label: "B" }],
      },
    ]);
    const match = html.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(match).not.toBeNull();
    const rendered = match![1]!;
    // Cap is 600 escaped chars + 1 for ellipsis. Allow tiny slack for entity
    // boundary back-off (an entity could shrink the cut by up to 3 chars).
    expect(rendered.length).toBeLessThanOrEqual(601);
    expect(rendered).toEndWith("…");
    // Must not contain a partial entity at the truncation boundary.
    expect(rendered).not.toMatch(/&[a-z]*…$/);
  });

  test("truncates oversized preview at 600 chars with ellipsis", () => {
    const preview = "x".repeat(800);
    const html = formatAskUserQuestion([
      {
        question: "Layout?",
        options: [{ label: "A", preview }, { label: "B" }],
      },
    ]);
    const expected = "x".repeat(600) + "…";
    expect(html).toContain(`<pre>${expected}</pre>`);
    expect(html).not.toContain("x".repeat(601));
  });

  test("renders multiple questions separated by blank line", () => {
    const html = formatAskUserQuestion([
      {
        question: "First?",
        options: [{ label: "A" }, { label: "B" }],
      },
      {
        question: "Second?",
        options: [{ label: "C" }, { label: "D" }],
      },
    ]);
    expect(html).toContain("First?");
    expect(html).toContain("Second?");
    // Blank line separating the two questions.
    expect(html).toMatch(/First\?[\s\S]*?\n\n[\s\S]*?<b>Q:<\/b> Second\?/);
  });

  test("oversized card emits truncation footer and drops trailing questions", () => {
    // 4 questions × heavy previews → forces drop of later questions.
    const bigPreview = "y".repeat(600);
    const items: AskUserQuestionItem[] = Array.from({ length: 4 }, (_, i) => ({
      question: `Question ${i}?`,
      options: Array.from({ length: 4 }, (_, j) => ({
        label: `Opt ${j}`,
        description: "z".repeat(80),
        preview: bigPreview,
      })),
    }));
    const html = formatAskUserQuestion(items);
    expect(html).toContain("(card truncated — see desktop for full options)");
    // First question always included.
    expect(html).toContain("Question 0?");
    // Last question dropped due to overflow.
    expect(html).not.toContain("Question 3?");
  });

  test("escapes HTML in option labels", () => {
    const html = formatAskUserQuestion([
      {
        question: "Pick",
        options: [{ label: "<script>alert(1)</script>" }, { label: "safe" }],
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("escapes HTML in question, header, description, preview", () => {
    const html = formatAskUserQuestion([
      {
        question: "<q>",
        header: "<h>",
        options: [{ label: "ok", description: "<d>", preview: "<p>" }],
      },
    ]);
    expect(html).not.toMatch(/<q>|<h>|<d>|<p>/);
    expect(html).toContain("&lt;q&gt;");
    expect(html).toContain("&lt;h&gt;");
    expect(html).toContain("&lt;d&gt;");
    expect(html).toContain("&lt;p&gt;");
  });

  test("empty questions list renders fallback card", () => {
    const html = formatAskUserQuestion([]);
    expect(html).toContain("❓ <b>Claude is asking</b>");
    expect(html).toContain("(no options visible)");
    expect(html).toContain("<i>Answer at the desktop.</i>");
  });
});
