import "./ensure-test-env";
import { describe, expect, test, beforeEach } from "bun:test";
import { HttpError } from "grammy";
import {
  installBridgeHealthTransformer,
  isBridgeOnline,
  onBridgeChange,
  _resetForTests,
} from "../bridge-health";

type Transformer = (
  prev: (m: string, p: unknown, s?: unknown) => Promise<unknown>,
  method: string,
  payload: unknown,
  signal?: unknown,
) => Promise<unknown>;

interface FakeApi {
  config: { use: (t: Transformer) => void };
}

function makeFakeApi(): { api: FakeApi; getTransformer: () => Transformer } {
  let captured: Transformer | null = null;
  return {
    api: { config: { use: (t) => (captured = t) } },
    getTransformer: () => {
      if (!captured) throw new Error("transformer not installed");
      return captured;
    },
  };
}

function httpError(): HttpError {
  // grammy's HttpError takes (message, error)
  return new HttpError("network down", new Error("ECONNRESET"));
}

describe("bridge-health", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("starts online", () => {
    expect(isBridgeOnline()).toBe(true);
  });

  test("flips offline after 3 consecutive HttpError, notifies listeners", async () => {
    const { api, getTransformer } = makeFakeApi();
    installBridgeHealthTransformer(api as never);
    const t = getTransformer();

    const events: boolean[] = [];
    onBridgeChange((online) => events.push(online));

    const prev = async () => {
      throw httpError();
    };

    for (let i = 0; i < 3; i++) {
      await expect(t(prev, "sendMessage", {})).rejects.toBeInstanceOf(
        HttpError,
      );
    }

    expect(isBridgeOnline()).toBe(false);
    expect(events).toEqual([false]);
  });

  test("does not flip offline on GrammyError-style failures (non-HttpError)", async () => {
    const { api, getTransformer } = makeFakeApi();
    installBridgeHealthTransformer(api as never);
    const t = getTransformer();

    const prev = async () => {
      throw new Error("user is blocked"); // not HttpError
    };

    for (let i = 0; i < 5; i++) {
      await expect(t(prev, "sendMessage", {})).rejects.toBeInstanceOf(Error);
    }
    expect(isBridgeOnline()).toBe(true);
  });

  test("recovers on first success after going offline, notifies listeners", async () => {
    const { api, getTransformer } = makeFakeApi();
    installBridgeHealthTransformer(api as never);
    const t = getTransformer();

    const events: boolean[] = [];
    onBridgeChange((online) => events.push(online));

    const failing = async () => {
      throw httpError();
    };
    const succeeding = async () => "ok";

    for (let i = 0; i < 3; i++) {
      await expect(t(failing, "sendMessage", {})).rejects.toBeInstanceOf(
        HttpError,
      );
    }
    expect(isBridgeOnline()).toBe(false);

    const res = await t(succeeding, "sendMessage", {});
    expect(res).toBe("ok");
    expect(isBridgeOnline()).toBe(true);
    expect(events).toEqual([false, true]);
  });

  test("resets consecutive-failure counter on success", async () => {
    const { api, getTransformer } = makeFakeApi();
    installBridgeHealthTransformer(api as never);
    const t = getTransformer();

    const failing = async () => {
      throw httpError();
    };
    const succeeding = async () => "ok";

    // 2 failures (below threshold)
    for (let i = 0; i < 2; i++) {
      await expect(t(failing, "sendMessage", {})).rejects.toBeInstanceOf(
        HttpError,
      );
    }
    // success resets the counter
    await t(succeeding, "sendMessage", {});

    // 2 more failures — should still be online (counter was reset)
    for (let i = 0; i < 2; i++) {
      await expect(t(failing, "sendMessage", {})).rejects.toBeInstanceOf(
        HttpError,
      );
    }
    expect(isBridgeOnline()).toBe(true);
  });

  test("unsubscribe removes listener", async () => {
    const { api, getTransformer } = makeFakeApi();
    installBridgeHealthTransformer(api as never);
    const t = getTransformer();

    const events: boolean[] = [];
    const unsub = onBridgeChange((online) => events.push(online));
    unsub();

    const failing = async () => {
      throw httpError();
    };
    for (let i = 0; i < 3; i++) {
      await expect(t(failing, "sendMessage", {})).rejects.toBeInstanceOf(
        HttpError,
      );
    }
    expect(events).toEqual([]);
  });
});
