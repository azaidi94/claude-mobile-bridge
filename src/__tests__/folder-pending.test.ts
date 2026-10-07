import { describe, test, expect, beforeEach } from "bun:test";
import {
  pendingFolderCreate,
  takePendingFolderName,
  validateFolderName,
  PENDING_FOLDER_TTL_MS,
} from "../menus/folder-pending";

const pick = { kind: "new.spawn" };

describe("validateFolderName", () => {
  test("accepts ordinary names", () => {
    for (const n of ["rem-engine", "My Project", "v2.0_beta", "a"]) {
      expect(validateFolderName(n)).toBeNull();
    }
  });
  test("rejects empty, dots, slashes, leading dot, too long", () => {
    for (const n of [
      "",
      "   ",
      ".",
      "..",
      "a/b",
      "a\\b",
      ".hidden",
      "x".repeat(65),
    ]) {
      expect(validateFolderName(n)).not.toBeNull();
    }
  });
});

describe("takePendingFolderName", () => {
  beforeEach(() => pendingFolderCreate.clear());

  test("nothing pending → null", () => {
    expect(takePendingFolderName("k", "x")).toBeNull();
  });

  test("valid name → create, entry consumed", () => {
    pendingFolderCreate.set("k", {
      parent: "/p",
      onPick: pick,
      createdAt: 1000,
    });
    expect(takePendingFolderName("k", " new-one ", 2000)).toEqual({
      kind: "create",
      name: "new-one",
      parent: "/p",
      onPick: pick,
    });
    expect(pendingFolderCreate.has("k")).toBe(false);
  });

  test("invalid name → reason, entry KEPT so the user can retry", () => {
    pendingFolderCreate.set("k", {
      parent: "/p",
      onPick: pick,
      createdAt: 1000,
    });
    const r = takePendingFolderName("k", "a/b", 2000);
    expect(r?.kind).toBe("invalid");
    expect(pendingFolderCreate.has("k")).toBe(true);
  });

  test("/cancel clears", () => {
    pendingFolderCreate.set("k", {
      parent: "/p",
      onPick: pick,
      createdAt: 1000,
    });
    expect(takePendingFolderName("k", "/cancel", 2000)).toEqual({
      kind: "cancel",
    });
    expect(pendingFolderCreate.has("k")).toBe(false);
  });

  test("expired → null and dropped", () => {
    pendingFolderCreate.set("k", {
      parent: "/p",
      onPick: pick,
      createdAt: 1000,
    });
    expect(
      takePendingFolderName("k", "late", 1000 + PENDING_FOLDER_TTL_MS + 1),
    ).toBeNull();
    expect(pendingFolderCreate.has("k")).toBe(false);
  });
});
