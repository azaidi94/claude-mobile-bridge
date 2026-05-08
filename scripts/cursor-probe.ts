#!/usr/bin/env bun
/**
 * Diagnose the Cursor bridge by talking directly to Cursor's CDP.
 *
 * Verifies each selector the observer + injector rely on, attempts an
 * injection probe, and reports what failed. Run while Cursor is open.
 *
 * Usage: bun run scripts/cursor-probe.ts
 */

import { listCdpTargets, connectCdpTarget } from "../src/cursor/cdp-client";
import { selectComposerTarget } from "../src/cursor/target-discovery";

const PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);

async function main() {
  console.log(`Connecting to Cursor CDP on port ${PORT}…`);
  const targets = await listCdpTargets(PORT);
  console.log(`Found ${targets.length} CDP targets`);
  const target = selectComposerTarget(targets);
  if (!target?.webSocketDebuggerUrl) {
    console.error(
      "No Composer target found. Make sure Cursor is open and showing the Composer panel.",
    );
    process.exit(1);
  }
  console.log(`Selected: ${target.title}`);

  const cdp = await connectCdpTarget(target.webSocketDebuggerUrl);

  const probe = `
(function() {
  const sels = {
    "user-msg": ['[data-message-role="human"]', '[data-message-role="user"]'],
    "ai-msg": ['[data-message-role="ai"][data-message-kind="assistant"]'],
    "ai-msg-any-kind": ['[data-message-role="ai"]'],
    "container": ['.composer-messages-container', '[data-testid="composer-messages"]'],
    "input": ['.aislash-editor-input', '[data-testid="composer-input"]', '.composer-input textarea', 'div[contenteditable="true"]'],
  };
  const out = {};
  for (const [k, list] of Object.entries(sels)) {
    out[k] = list.map(s => ({ selector: s, count: document.querySelectorAll(s).length }));
  }
  // Active input details
  const inputEl = document.querySelector('.aislash-editor-input')
    ?? document.querySelector('div[contenteditable="true"]');
  out["inputDetail"] = inputEl ? {
    tag: inputEl.tagName,
    contentEditable: inputEl.contentEditable,
    isConnected: inputEl.isConnected,
    classes: inputEl.className?.slice(0, 80),
    sampleHtml: inputEl.outerHTML?.slice(0, 200),
  } : null;
  // Last user message text (sanity-check observer source data)
  const userBubbles = document.querySelectorAll('[data-message-role="human"]');
  out["lastUserMsg"] = userBubbles.length > 0
    ? (userBubbles[userBubbles.length - 1].querySelector('.composer-human-message-content')?.textContent
       ?? userBubbles[userBubbles.length - 1].textContent
      )?.trim().slice(0, 120)
    : null;
  // AI bubble inspection — what kinds exist, what text container, sample
  const aiBubbles = document.querySelectorAll('[data-message-role="ai"]');
  out["aiBubbleKinds"] = Array.from(aiBubbles).map(b => b.getAttribute('data-message-kind'));
  if (aiBubbles.length > 0) {
    const last = aiBubbles[aiBubbles.length - 1];
    const markdown = last.querySelector('.markdown-root');
    out["lastAiBubble"] = {
      kind: last.getAttribute('data-message-kind'),
      hasMarkdownRoot: !!markdown,
      markdownText: markdown?.textContent?.trim().slice(0, 200),
      fallbackText: last.textContent?.trim().slice(0, 200),
      classNames: last.className?.slice(0, 200),
      childTags: Array.from(last.children).map(c => c.tagName + (c.className ? '.' + c.className.split(' ')[0] : '')).slice(0, 5),
    };
  }
  return out;
})()
`;

  const probeResult = await cdp.sendCommand("Runtime.evaluate", {
    expression: probe,
    returnByValue: true,
  });
  console.log("\n=== Selector audit ===");
  console.log(JSON.stringify((probeResult as any).result?.value, null, 2));
  if ((probeResult as any).exceptionDetails) {
    console.error("Probe threw:");
    console.error(
      JSON.stringify((probeResult as any).exceptionDetails, null, 2),
    );
  }

  // Now try the actual inject script with a unique test marker.
  const testText = `bridge-probe-${Date.now()}`;
  console.log(`\n=== Inject probe: "${testText}" ===`);

  // Test extractMarkdown on the latest AI bubble — useful when something
  // looks wrong in TG/Web after a Cursor reply. This is a copy of the
  // helper from composer-io.ts; it should produce the same output the
  // real observer would emit.
  const extractTest = `
(function() {
  function walkChildren(node) { let out = ""; for (const c of node.childNodes) out += walk(c); return out; }
  function renderTable(table) {
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = [];
      for (const cell of tr.querySelectorAll("th, td")) {
        cells.push((cell.textContent || "").trim().replace(/\\|/g, "\\\\|"));
      }
      if (cells.length) rows.push("| " + cells.join(" | ") + " |");
    }
    if (rows.length >= 2) {
      const colCount = (rows[0].match(/\\|/g) || []).length - 1;
      const sep = "| " + Array(colCount).fill("---").join(" | ") + " |";
      rows.splice(1, 0, sep);
    }
    return "\\n\\n" + rows.join("\\n") + "\\n\\n";
  }
  function walk(node) {
    if (node.nodeType === 3) return node.textContent || "";
    if (!(node instanceof Element)) return "";
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case "table": return renderTable(node);
      case "pre": { const c = node.querySelector("code"); return "\\n\\n\`\`\`\\n" + ((c||node).textContent||"").replace(/\\n+$/, "") + "\\n\`\`\`\\n\\n"; }
      case "code": if (node.parentElement && node.parentElement.tagName === "PRE") return ""; return "\`" + (node.textContent || "") + "\`";
      case "strong": case "b": return "**" + walkChildren(node) + "**";
      case "em": case "i": return "*" + walkChildren(node) + "*";
      case "a": { const h = node.getAttribute("href") || ""; const t = walkChildren(node); return h ? "[" + t + "](" + h + ")" : t; }
      case "br": return "\\n";
      case "p": case "div": return walkChildren(node) + "\\n\\n";
      case "ul": case "ol": return walkChildren(node) + "\\n";
      case "li": return "- " + walkChildren(node).trim() + "\\n";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": { const lvl = +tag.slice(1); return "\\n" + "#".repeat(lvl) + " " + walkChildren(node).trim() + "\\n\\n"; }
      case "blockquote": return walkChildren(node).split("\\n").map(l => l ? "> " + l : "").join("\\n") + "\\n";
      case "hr": return "\\n---\\n";
      default: return walkChildren(node);
    }
  }
  function extractMarkdown(root) { return walk(root).replace(/\\n{3,}/g, "\\n\\n").trim(); }
  const last = document.querySelectorAll('[data-message-role="ai"][data-message-kind="assistant"]');
  if (last.length === 0) return { error: "no AI bubble" };
  const bubble = last[last.length - 1];
  const root = bubble.querySelector('.markdown-root') || bubble;
  return { markdown: extractMarkdown(root).slice(0, 1200), totalAi: last.length };
})()`;
  const extractResult = await cdp.sendCommand("Runtime.evaluate", {
    expression: extractTest,
    returnByValue: true,
  });
  console.log("\n=== Markdown extraction of latest AI bubble ===");
  console.log(JSON.stringify((extractResult as any).result?.value, null, 2));
  if ((extractResult as any).exceptionDetails) {
    console.error(
      JSON.stringify((extractResult as any).exceptionDetails, null, 2),
    );
  }

  // Probe several injection strategies on Lexical and report which one
  // actually mutates the DOM. We do NOT submit (no Enter), so the user
  // can see the text sitting in the composer if it works.
  const text = testText;
  const injectScript = `
(async function() {
  const el = document.querySelector('.aislash-editor-input') ?? document.querySelector('div[contenteditable="true"]');
  if (!el) return { error: 'no input' };

  function readText() { return (el.textContent ?? '').trim(); }
  async function clearAndWait() {
    el.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    await new Promise(r => setTimeout(r, 50));
  }

  const text = ${JSON.stringify(text)};
  const results = {};

  // Strategy A: paste event with DataTransfer
  await clearAndWait();
  el.focus();
  const dt1 = new DataTransfer();
  dt1.setData('text/plain', text + '_A');
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt1, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 100));
  results.paste = readText();

  // Strategy B: beforeinput with insertFromPaste + dataTransfer
  await clearAndWait();
  el.focus();
  const dt2 = new DataTransfer();
  dt2.setData('text/plain', text + '_B');
  el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: dt2, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 100));
  results.beforeinputPaste = readText();

  // Strategy C: beforeinput with insertText + data
  await clearAndWait();
  el.focus();
  el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text + '_C', bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 100));
  results.beforeinputText = readText();

  // Strategy D: execCommand insertText
  await clearAndWait();
  el.focus();
  document.execCommand('insertText', false, text + '_D');
  await new Promise(r => setTimeout(r, 100));
  results.execCommand = readText();

  await clearAndWait();
  return results;
})()`;

  const injectResult = await cdp.sendCommand("Runtime.evaluate", {
    expression: injectScript,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify((injectResult as any).result?.value, null, 2));
  if ((injectResult as any).exceptionDetails) {
    console.error("Inject threw:");
    console.error(
      JSON.stringify((injectResult as any).exceptionDetails, null, 2),
    );
  }

  cdp.close();
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
