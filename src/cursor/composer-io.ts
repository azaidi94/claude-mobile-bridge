// src/cursor/composer-io.ts

// Cursor's Composer DOM (verified against Cursor 2.1.132 / Electron 39):
// - User message bubble: <div data-message-role="human" data-message-kind="human">
//   inner text is in .composer-human-message-content
// - AI message bubble:   <div data-message-role="ai" data-message-kind="assistant|tool">
//   inner text is in .markdown-root
// - Messages container: .composer-messages-container
// - Composer input: <div contenteditable="true" class="aislash-editor-input">
const USER_MSG_SELECTORS = [
  '[data-message-role="human"]',
  '[data-message-role="user"]',
];
const AI_MSG_SELECTORS = [
  '[data-message-role="ai"][data-message-kind="assistant"]',
];

// Inside a user-message bubble, this is the text-bearing element.
// If absent (older/newer Cursor builds), fall back to bubble.textContent.
const USER_MSG_TEXT_SELECTOR = ".composer-human-message-content";
const AI_MSG_TEXT_SELECTOR = ".markdown-root";

// AI messages stream incrementally; debounce so we emit once when text settles.
const AI_DEBOUNCE_MS = 1500;

const CHAT_CONTAINER_SELECTORS = [
  ".composer-messages-container",
  '[data-testid="composer-messages"]',
];

const INPUT_SELECTORS = [
  ".aislash-editor-input",
  '[data-testid="composer-input"]',
  ".composer-input textarea",
  'div[contenteditable="true"]',
];

export interface ObserverBindings {
  /** Fired with the trimmed text of each new user message (data-message-role=human). */
  human: string;
  /**
   * Fired with the trimmed text of each completed AI message
   * (data-message-role=ai). Streamed text is debounced — the binding fires
   * once content has been stable for a short period.
   */
  ai: string;
}

/**
 * Walk a rendered AI bubble's DOM and reconstruct markdown so
 * tables/code/lists/links survive the trip to TG and Web. Also
 * embedded into the observer script via .toString() — keeping a single
 * source of truth that's directly testable in Node-side tests.
 *
 * Note: written in plain JS style (no TS-only features at runtime, no
 * outer-scope refs, no class methods) so Function.prototype.toString
 * yields valid page-context source. Don't introduce optional chaining
 * cascades, decorators, or imports inside these helpers.
 */
export function extractMarkdown(root: Element | null): string {
  if (!root) return "";
  return walk(root)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function walk(node: Node): string {
  if (node.nodeType === 3 /* TEXT_NODE */) return node.textContent || "";
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "table":
      return renderTable(el);
    case "pre": {
      const codeEl = el.querySelector("code");
      const code = (codeEl ?? el).textContent || "";
      return "\n\n```\n" + code.replace(/\n+$/, "") + "\n```\n\n";
    }
    case "code":
      if (el.parentElement && el.parentElement.tagName === "PRE") return "";
      return "`" + (el.textContent || "") + "`";
    case "strong":
    case "b":
      return "**" + walkChildren(el) + "**";
    case "em":
    case "i":
      return "*" + walkChildren(el) + "*";
    case "a": {
      const href = el.getAttribute("href") || "";
      const txt = walkChildren(el);
      return href ? "[" + txt + "](" + href + ")" : txt;
    }
    case "br":
      return "\n";
    case "p":
    case "div":
      return walkChildren(el) + "\n\n";
    case "ul":
    case "ol":
      return walkChildren(el) + "\n";
    case "li":
      return "- " + walkChildren(el).trim() + "\n";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const lvl = +tag.slice(1);
      return "\n" + "#".repeat(lvl) + " " + walkChildren(el).trim() + "\n\n";
    }
    case "blockquote":
      return (
        walkChildren(el)
          .split("\n")
          .map((l) => (l ? "> " + l : ""))
          .join("\n") + "\n"
      );
    case "hr":
      return "\n---\n";
    default:
      return walkChildren(el);
  }
}

export function walkChildren(node: Element): string {
  let out = "";
  for (const c of Array.from(node.childNodes)) out += walk(c);
  return out;
}

export function renderTable(table: Element): string {
  const rows: string[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells: string[] = [];
    for (const cell of Array.from(tr.querySelectorAll("th, td"))) {
      cells.push((cell.textContent || "").trim().replace(/\|/g, "\\|"));
    }
    if (cells.length) rows.push("| " + cells.join(" | ") + " |");
  }
  if (rows.length >= 2) {
    const colCount = (rows[0]!.match(/\|/g) || []).length - 1;
    const sep = "| " + Array(colCount).fill("---").join(" | ") + " |";
    rows.splice(1, 0, sep);
  }
  return "\n\n" + rows.join("\n") + "\n\n";
}

/**
 * Source string for the markdown helpers, used by buildObserverScript
 * to inline them into the page-evaluated observer. Single source of
 * truth: same logic that's tested via the exports above runs in Cursor.
 *
 * Exported for tests so we can verify the post-transpile string still
 * parses as valid JavaScript (no TS-only feature leaked into the
 * page-side observer that would only blow up at runtime in Cursor).
 */
export const MARKDOWN_HELPERS_SOURCE =
  walk.toString() +
  "\n" +
  walkChildren.toString() +
  "\n" +
  renderTable.toString() +
  "\n" +
  extractMarkdown.toString();

/**
 * Returns a JS expression to evaluate inside the Cursor Composer webview.
 * The script:
 *   1. Takes a snapshot of already-visible user messages (returned as string[])
 *   2. Sets up a MutationObserver — fires `bindings.human` when a new user
 *      bubble appears, and fires `bindings.ai` when a new AI bubble's text
 *      stops changing for AI_DEBOUNCE_MS.
 *
 * Return value is a JSON-serialisable string[] of existing user messages.
 */
export function buildObserverScript(bindings: ObserverBindings): string {
  const userSelList = USER_MSG_SELECTORS.map((s) => JSON.stringify(s)).join(
    ", ",
  );
  const aiSelList = AI_MSG_SELECTORS.map((s) => JSON.stringify(s)).join(", ");
  const containerSelList = CHAT_CONTAINER_SELECTORS.map((s) =>
    JSON.stringify(s),
  ).join(", ");
  const userTextSel = JSON.stringify(USER_MSG_TEXT_SELECTOR);
  const aiTextSel = JSON.stringify(AI_MSG_TEXT_SELECTOR);

  return `
(function() {
  const userSelectors = [${userSelList}];
  const aiSelectors = [${aiSelList}];
  const containerSelectors = [${containerSelList}];
  const userTextSelector = ${userTextSel};
  const aiTextSelector = ${aiTextSel};
  const humanBinding = ${JSON.stringify(bindings.human)};
  const aiBinding = ${JSON.stringify(bindings.ai)};
  const aiDebounceMs = ${AI_DEBOUNCE_MS};

  function getInnerText(node, sel) {
    if (!(node instanceof Element)) return "";
    const inner = node.querySelector(sel);
    return (inner?.textContent ?? node.textContent ?? "").trim();
  }

  // Markdown extraction helpers, inlined from composer-io.ts via
  // Function.prototype.toString. Same source the unit tests run.
  ${MARKDOWN_HELPERS_SOURCE}

  function matches(node, selectors) {
    if (!(node instanceof Element)) return false;
    return selectors.some(s => node.matches(s));
  }

  // Snapshot existing user messages so we don't replay history.
  const existing = [];
  for (const sel of userSelectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) {
      existing.push(...Array.from(nodes).map(n => getInnerText(n, userTextSelector)).filter(Boolean));
      break;
    }
  }

  // Snapshot existing AI bubbles too — these are history and shouldn't fire.
  const aiSeen = new WeakSet();
  for (const sel of aiSelectors) {
    document.querySelectorAll(sel).forEach(el => aiSeen.add(el));
  }

  let container = null;
  for (const sel of containerSelectors) {
    container = document.querySelector(sel);
    if (container) break;
  }
  if (!container) container = document.body;

  // Per-AI-bubble debounce: when the bubble's content settles, fire once.
  const aiTimers = new WeakMap();
  function scheduleAiEmit(bubble) {
    if (aiSeen.has(bubble)) return; // already fired
    clearTimeout(aiTimers.get(bubble));
    const timer = setTimeout(() => {
      if (aiSeen.has(bubble)) return;
      const root = bubble.querySelector(aiTextSelector) || bubble;
      const text = extractMarkdown(root);
      if (text) {
        aiSeen.add(bubble);
        window[aiBinding](text);
      }
    }, aiDebounceMs);
    aiTimers.set(bubble, timer);
  }

  // Walk up to find the closest AI bubble for any mutation target.
  function findAiBubble(node) {
    if (!(node instanceof Element)) {
      node = node.parentElement;
      if (!node) return null;
    }
    return node.closest(aiSelectors.join(", "));
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // 1. Added nodes — detect new user messages immediately.
      for (const node of mutation.addedNodes) {
        if (matches(node, userSelectors)) {
          const text = getInnerText(node, userTextSelector);
          if (text) window[humanBinding](text);
        } else if (matches(node, aiSelectors)) {
          scheduleAiEmit(node);
        } else if (node instanceof Element) {
          // Wrapper case: bubbles may be nested inside an added container.
          node.querySelectorAll(userSelectors.join(", ")).forEach(el => {
            const text = getInnerText(el, userTextSelector);
            if (text) window[humanBinding](text);
          });
          node.querySelectorAll(aiSelectors.join(", ")).forEach(el => {
            scheduleAiEmit(el);
          });
        }
      }

      // 2. Existing AI bubble's content changing — reset its debounce.
      const aiBubble = findAiBubble(mutation.target);
      if (aiBubble) scheduleAiEmit(aiBubble);
    }
  });

  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return existing;
})()
`;
}

/**
 * Returns a JS expression that injects text into Cursor's Composer input and submits.
 *
 * Cursor's input (`.aislash-editor-input`) is a Lexical editor —
 * `data-lexical-editor="true"` contenteditable div. Lexical ignores
 * `execCommand('insertText')` and the native HTMLInputElement.value setter
 * doesn't apply to a div. The reliable path is a synthetic paste event
 * with a `text/plain` DataTransfer payload — Lexical's paste handler
 * inserts the text via its internal mutation API.
 */
export function buildInjectScript(text: string): string {
  const jsLiteral = JSON.stringify(text);
  const selList = INPUT_SELECTORS.map((s) => JSON.stringify(s)).join(", ");

  return `
(function() {
  const selectors = [${selList}];
  let el = null;
  for (const sel of selectors) {
    el = document.querySelector(sel);
    if (el) break;
  }
  if (!el) throw new Error('Cursor Composer input not found');

  const text = ${jsLiteral};
  const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';

  if (isInput) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    // Contenteditable — works for Lexical/ProseMirror/Slate via paste event.
    el.focus();
    // Clear any existing content so the new injection isn't appended
    // to leftover text (e.g. partial probe markers, draft input).
    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch (e) {
      // silently ok: best-effort clear in browser eval; no logger available in CDP context
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true,
    }));
  }

  // Submit. Lexical's submit handler listens on keydown Enter (without shift).
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));
  return true;
})()
`;
}

/**
 * Parse the CDP evaluate result from buildObserverScript (the initial snapshot).
 */
export function parseSnapshotResult(cdpResult: unknown): string[] {
  if (!cdpResult || typeof cdpResult !== "object") return [];
  const r = (cdpResult as { result?: { type?: string; value?: unknown } })
    .result;
  if (!r || !Array.isArray(r.value)) return [];
  return (r.value as unknown[]).filter(
    (x): x is string => typeof x === "string",
  );
}
