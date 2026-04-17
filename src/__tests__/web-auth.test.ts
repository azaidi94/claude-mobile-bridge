import "./ensure-test-env";
import { describe, test, expect } from "bun:test";
import { createHmac } from "crypto";
import { validateInitData } from "../web/auth";

function makeInitData(
  botToken: string,
  userId: number,
  timestamp?: number,
): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const pairs = [
    `auth_date=${ts}`,
    `user={"id":${userId},"first_name":"Test"}`,
  ].sort();
  const dataCheckString = pairs.join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  return `${pairs.join("&")}&hash=${hash}`;
}

describe("validateInitData", () => {
  test("accepts valid initData", () => {
    const initData = makeInitData("test-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(true);
  });

  test("rejects wrong token", () => {
    const initData = makeInitData("other-token", 42);
    expect(validateInitData(initData, "test-token")).toBe(false);
  });

  test("rejects stale initData (> 5 minutes old)", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const initData = makeInitData("test-token", 42, staleTs);
    expect(validateInitData(initData, "test-token", 300)).toBe(false);
  });

  test("accepts fresh initData within window", () => {
    const ts = Math.floor(Date.now() / 1000) - 60;
    const initData = makeInitData("test-token", 42, ts);
    expect(validateInitData(initData, "test-token", 300)).toBe(true);
  });
});
