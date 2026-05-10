// src/__tests__/cursor-target-discovery.test.ts
import { describe, it, expect } from "bun:test";
import { selectComposerTarget } from "../cursor/target-discovery";
import type { CdpTarget } from "../cursor/cdp-client";

describe("selectComposerTarget", () => {
  const targets: CdpTarget[] = [
    {
      id: "1",
      type: "service_worker",
      title: "sw",
      url: "chrome-extension://abc/sw.js",
    },
    {
      id: "2",
      type: "page",
      title: "Cursor",
      url: "vscode-webview://cursor.app/composer",
    },
    {
      id: "3",
      type: "page",
      title: "Getting Started",
      url: "vscode-webview://cursor.app/welcome",
    },
  ];

  it("prefers target whose URL contains a composer/chat hint", () => {
    const t = selectComposerTarget(targets);
    expect(t?.id).toBe("2");
  });

  it("falls back to first page target when no URL hint matches", () => {
    const plain: CdpTarget[] = [
      {
        id: "1",
        type: "service_worker",
        title: "sw",
        url: "chrome-extension://x/sw.js",
      },
      {
        id: "2",
        type: "page",
        title: "Something",
        url: "vscode-webview://cursor.app/other",
      },
    ];
    expect(selectComposerTarget(plain)?.id).toBe("2");
  });

  it("returns null when no page targets exist", () => {
    expect(selectComposerTarget([])).toBeNull();
    expect(
      selectComposerTarget([
        { id: "1", type: "service_worker", title: "sw", url: "x" },
      ]),
    ).toBeNull();
  });
});
