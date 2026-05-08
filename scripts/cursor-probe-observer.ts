#!/usr/bin/env bun
/**
 * Diagnose whether the bot's AI-message observer is actually attached
 * and firing. Installs an instrumented parallel observer that captures
 * mutations to a window-global; you trigger an AI response in Cursor;
 * re-run this script to see what the observer caught.
 *
 * Usage:
 *   1. bun run scripts/cursor-probe-observer.ts install
 *   2. trigger an AI response in Cursor
 *   3. bun run scripts/cursor-probe-observer.ts read
 */

import { listCdpTargets, connectCdpTarget } from "../src/cursor/cdp-client";
import { selectComposerTarget } from "../src/cursor/target-discovery";

const PORT = Number(process.env.CURSOR_CDP_PORT ?? 9222);

async function getCdp() {
  const targets = await listCdpTargets(PORT);
  const target = selectComposerTarget(targets);
  if (!target?.webSocketDebuggerUrl) throw new Error("No Composer target");
  return await connectCdpTarget(target.webSocketDebuggerUrl);
}

const installScript = `
(function() {
  if (window.__bridgeProbe) {
    window.__bridgeProbe.observer?.disconnect?.();
  }
  const probe = {
    aiAdded: 0,
    aiContentMutations: 0,
    aiBindingFires: 0,
    aiTexts: [],
    log: [],
  };
  window.__bridgeProbe = probe;

  const aiSelectors = ['[data-message-role="ai"][data-message-kind="assistant"]'];
  const container = document.querySelector('.composer-messages-container') ?? document.body;

  // Snapshot existing AI bubbles so we only count NEW ones.
  const initiallySeen = new WeakSet();
  document.querySelectorAll(aiSelectors[0]).forEach(el => initiallySeen.add(el));
  probe.log.push('initial AI bubbles: ' + document.querySelectorAll(aiSelectors[0]).length);

  function findAiBubble(node) {
    if (!(node instanceof Element)) {
      node = node?.parentElement;
      if (!node) return null;
    }
    return node.closest(aiSelectors.join(', '));
  }

  function note(bubble, reason) {
    if (initiallySeen.has(bubble)) return;
    probe.aiContentMutations++;
    const text = (bubble.querySelector('.markdown-root')?.textContent ?? bubble.textContent ?? '').trim();
    if (text && !probe.aiTexts.find(t => t === text)) {
      // dedupe by full text
      probe.aiTexts.push(text.slice(0, 200));
    }
    probe.log.push(reason + ' kind=' + bubble.getAttribute('data-message-kind') + ' text=' + text.slice(0, 60));
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof Element) {
          if (node.matches(aiSelectors[0])) {
            probe.aiAdded++;
            note(node, 'added-direct');
          } else {
            node.querySelectorAll(aiSelectors[0]).forEach(el => {
              probe.aiAdded++;
              note(el, 'added-wrapper');
            });
          }
        }
      }
      const bubble = findAiBubble(m.target);
      if (bubble) note(bubble, 'mut-target');
    }
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  probe.observer = observer;

  return { installed: true, container: container?.className?.slice(0, 60), initialAi: document.querySelectorAll(aiSelectors[0]).length };
})()
`;

const readScript = `
(function() {
  const p = window.__bridgeProbe;
  if (!p) return { error: 'probe not installed' };
  return {
    aiAdded: p.aiAdded,
    aiContentMutations: p.aiContentMutations,
    uniqueAiTexts: p.aiTexts.length,
    sampleTexts: p.aiTexts.slice(-3),
    recentLog: p.log.slice(-15),
  };
})()
`;

async function main() {
  const cmd = process.argv[2] ?? "install";
  const cdp = await getCdp();
  const expr = cmd === "read" ? readScript : installScript;
  const r = await cdp.sendCommand("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  console.log(JSON.stringify((r as any).result?.value, null, 2));
  if ((r as any).exceptionDetails) {
    console.error(
      "Threw:",
      JSON.stringify((r as any).exceptionDetails, null, 2),
    );
  }
  cdp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
