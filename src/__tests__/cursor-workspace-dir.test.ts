import "./ensure-test-env";
import { describe, test, expect } from "bun:test";
import { matchWorkspaceDir, extractWorkspaceName } from "../cursor";

describe("extractWorkspaceName", () => {
  test("strips the leading 'X — ' segment and returns the workspace name", () => {
    expect(extractWorkspaceName("2.1.141 — claude-mobile-bridge")).toBe(
      "claude-mobile-bridge",
    );
    expect(extractWorkspaceName("compose.local.env — kinetix-cloud")).toBe(
      "kinetix-cloud",
    );
  });

  test("drops a trailing [SSH: …] / [WSL: …] suffix Cursor appends to remotes", () => {
    expect(
      extractWorkspaceName(
        "build_newpod.sh — Monkey_OCR [SSH: runpod-instance-qrsikj9k3]",
      ),
    ).toBe("monkey_ocr");
  });

  test("lowercases and collapses whitespace to dashes", () => {
    expect(extractWorkspaceName("file.ts — My Big Workspace")).toBe(
      "my-big-workspace",
    );
  });

  test("returns the whole title when there's no ' — ' separator", () => {
    expect(extractWorkspaceName("just-a-name")).toBe("just-a-name");
  });
});

describe("matchWorkspaceDir", () => {
  test("returns the matching directory on a unique basename hit", () => {
    const dirs = [
      "/Users/me/Projects/claude-mobile-bridge",
      "/Users/me/Projects/saas-builder",
      "/tmp/unrelated",
    ];
    expect(matchWorkspaceDir("2.1.141 — claude-mobile-bridge", dirs)).toBe(
      "/Users/me/Projects/claude-mobile-bridge",
    );
  });

  test("returns null on ambiguous match (two dirs share a basename)", () => {
    const dirs = ["/Users/me/a/saas-builder", "/Users/me/b/saas-builder"];
    expect(matchWorkspaceDir("file — saas-builder", dirs)).toBeNull();
  });

  test("returns null when nothing matches", () => {
    const dirs = ["/Users/me/Projects/other"];
    expect(matchWorkspaceDir("file — claude-mobile-bridge", dirs)).toBeNull();
  });

  test("ignores SSH suffix when matching", () => {
    const dirs = ["/Users/me/Projects/Monkey_OCR"];
    expect(
      matchWorkspaceDir("build.sh — Monkey_OCR [SSH: runpod-instance]", dirs),
    ).toBe("/Users/me/Projects/Monkey_OCR");
  });

  test("matches case-insensitively (basename casing in title vs dir)", () => {
    const dirs = ["/Users/me/Projects/CLAUDE-Mobile-Bridge"];
    expect(matchWorkspaceDir("2.1.141 — claude-mobile-bridge", dirs)).toBe(
      "/Users/me/Projects/CLAUDE-Mobile-Bridge",
    );
  });

  test("empty candidate set yields null", () => {
    expect(matchWorkspaceDir("foo — bar", [])).toBeNull();
  });
});
