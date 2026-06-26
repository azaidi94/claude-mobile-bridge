import { describe, test, expect } from "bun:test";
import { pickRelayIds } from "../sessions/watcher";
import type { ResolvedIdentity } from "../sessions/identity";

const ident = (o: Partial<ResolvedIdentity>): ResolvedIdentity => ({
  claudePid: 1,
  relayPid: 1,
  cwd: "/p",
  sessionId: null,
  provenance: "missing",
  topicId: null,
  ...o,
});

describe("pickRelayIds (watcher id consumption)", () => {
  test("authoritative → its sessionId, consuming no fallback", () => {
    expect(
      pickRelayIds(
        [ident({ provenance: "authoritative", sessionId: "sid-a" })],
        ["f1"],
      ),
    ).toEqual(["sid-a"]);
  });

  // Regression (replaces the deleted resolveSiblingId test): ambiguous siblings
  // must resolve EMPTY and must NOT consume a JSONL fallback — guessing one would
  // grab a sibling's transcript and misroute. Exact pid routing handles them.
  test("ambiguous siblings → all empty, fallbacks untouched", () => {
    expect(
      pickRelayIds(
        [
          ident({ provenance: "ambiguous" }),
          ident({ provenance: "ambiguous" }),
        ],
        ["f1", "f2"],
      ),
    ).toEqual(["", ""]);
  });

  test("lone missing relays back-fill from JSONL fallbacks in order", () => {
    expect(
      pickRelayIds(
        [ident({ provenance: "missing" }), ident({ provenance: "missing" })],
        ["f1", "f2"],
      ),
    ).toEqual(["f1", "f2"]);
  });

  test("missing with exhausted fallbacks → empty", () => {
    expect(pickRelayIds([ident({ provenance: "missing" })], [])).toEqual([""]);
  });

  test("mixed order consumes fallbacks only for missing, in sequence", () => {
    const out = pickRelayIds(
      [
        ident({ provenance: "authoritative", sessionId: "sid" }),
        ident({ provenance: "missing" }),
        ident({ provenance: "ambiguous" }),
        ident({ provenance: "missing" }),
      ],
      ["f1", "f2"],
    );
    expect(out).toEqual(["sid", "f1", "", "f2"]);
  });

  test("undefined identity (no resolver entry) → empty, defensively", () => {
    expect(pickRelayIds([undefined], ["f1"])).toEqual([""]);
  });
});
