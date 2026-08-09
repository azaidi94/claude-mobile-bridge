import { describe, it, expect } from "bun:test";
import {
  parseAcCallback,
  applyAnswer,
  nextAcStep,
  buildStepPrompt,
  formatInstallSummary,
  scrubGitEnv,
} from "../handlers/commands/installac";

describe("installac handler — parseAcCallback", () => {
  it("parses a well-formed acinstall callback", () => {
    expect(parseAcCallback("acinstall:tracker:jira")).toEqual({
      step: "tracker",
      value: "jira",
    });
    expect(parseAcCallback("acinstall:base:develop")).toEqual({
      step: "base",
      value: "develop",
    });
    expect(parseAcCallback("acinstall:ship:push-only")).toEqual({
      step: "ship",
      value: "push-only",
    });
    expect(parseAcCallback("acinstall:ralph:yes")).toEqual({
      step: "ralph",
      value: "yes",
    });
  });

  it("rejects unknown steps and malformed data", () => {
    expect(parseAcCallback("acinstall:bogus:x")).toBeNull();
    expect(parseAcCallback("acinstall:tracker")).toBeNull();
    expect(parseAcCallback("ralph:deltopic:1")).toBeNull();
  });
});

describe("installac handler — applyAnswer", () => {
  it("accepts valid values per step", () => {
    expect(applyAnswer("tracker", "github")).toEqual({ tracker: "github" });
    expect(applyAnswer("base", "main")).toEqual({ baseBranch: "main" });
    expect(applyAnswer("ship", "direct-merge")).toEqual({
      shipPolicy: "direct-merge",
    });
    expect(applyAnswer("ralph", "no")).toEqual({ installRalphPrompt: false });
    expect(applyAnswer("ralph", "yes")).toEqual({ installRalphPrompt: true });
  });

  it("rejects invalid values per step", () => {
    expect(applyAnswer("tracker", "trello")).toBeNull();
    expect(applyAnswer("base", "trunk")).toBeNull();
    expect(applyAnswer("ship", "yolo")).toBeNull();
    expect(applyAnswer("ralph", "maybe")).toBeNull();
  });
});

describe("installac handler — nextAcStep", () => {
  it("walks tracker -> base -> ship -> ralph -> null", () => {
    expect(nextAcStep("tracker")).toBe("base");
    expect(nextAcStep("base")).toBe("ship");
    expect(nextAcStep("ship")).toBe("ralph");
    expect(nextAcStep("ralph")).toBeNull();
  });
});

describe("installac handler — buildStepPrompt", () => {
  it("Q1 has no accumulated answers and offers tracker options", () => {
    const p = buildStepPrompt("tracker", {});
    expect(p.buttons.map((b) => b.data)).toEqual([
      "acinstall:tracker:jira",
      "acinstall:tracker:github",
      "acinstall:tracker:none",
    ]);
    expect(p.text).not.toContain("Tracker:");
  });

  it("later steps echo prior answers in the text", () => {
    const p = buildStepPrompt("ship", {
      tracker: "jira",
      baseBranch: "develop",
    });
    expect(p.text).toContain("jira");
    expect(p.text).toContain("develop");
    expect(p.buttons.map((b) => b.data)).toEqual([
      "acinstall:ship:pr",
      "acinstall:ship:push-only",
      "acinstall:ship:direct-merge",
    ]);
  });
});

describe("installac handler — formatInstallSummary", () => {
  it("reports a fresh install", () => {
    const text = formatInstallSummary({
      repoLabel: "/repo",
      oldVersion: null,
      newVersion: 1,
      fileCount: 8,
      bindingsWritten: true,
      ralphInstalled: true,
      committed: true,
    });
    expect(text).toContain("Installed ac-pipeline v1");
    expect(text).toContain("8 files");
    expect(text).toContain("/ralph");
    expect(text).toContain("/new");
  });

  it("reports an upgrade with preserved bindings and no ralph prompt", () => {
    const text = formatInstallSummary({
      repoLabel: "/repo",
      oldVersion: 1,
      newVersion: 2,
      fileCount: 8,
      bindingsWritten: false,
      ralphInstalled: false,
      committed: true,
    });
    expect(text).toContain("Upgraded ac-pipeline v1 → v2");
    expect(text).toContain("preserved");
    expect(text).not.toContain("/ralph /repo");
  });

  it("flags a failed commit", () => {
    const text = formatInstallSummary({
      repoLabel: "/repo",
      oldVersion: 1,
      newVersion: 1,
      fileCount: 8,
      bindingsWritten: true,
      ralphInstalled: false,
      committed: false,
    });
    expect(text).toContain("already up to date");
    expect(text.toLowerCase()).toContain("commit failed");
  });
});

describe("installac handler — scrubGitEnv", () => {
  it("removes GIT_* overrides but keeps everything else", () => {
    const env = scrubGitEnv({
      PATH: "/usr/bin",
      GIT_DIR: "/somewhere/.git",
      GIT_INDEX_FILE: "/somewhere/index",
      GIT_WORK_TREE: "/somewhere",
      GIT_COMMON_DIR: "/somewhere/.git",
      GIT_PREFIX: "sub/",
      GIT_OBJECT_DIRECTORY: "/somewhere/.git/objects",
      HOME: "/home/user",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });
});
