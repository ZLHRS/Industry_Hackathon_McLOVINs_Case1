import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActor,
  enqueue,
  getSnapshot,
  listPending,
  removePending,
  retryPending,
  saveSnapshot,
  syncPending,
  type PendingAction,
} from "./offline";

const alice = "offline-test-alice";
const bob = "offline-test-bob";
const action = (orderId = "order-a", actorId = alice) => ({
  actorId,
  orderId,
  request: { action: "accept", expected_version: 3 },
});
beforeEach(async () => {
  await clearActor(alice);
  await clearActor(bob);
});
afterEach(() => vi.restoreAllMocks());

describe("private durable snapshots", () => {
  it("isolates users and clears only the departing account", async () => {
    await saveSnapshot(alice, "orders", { names: ["one"] });
    await saveSnapshot(bob, "orders", { names: ["two"] });
    await enqueue(action());
    await enqueue(action("order-a", bob));
    expect((await getSnapshot<{ names: string[] }>(alice, "orders"))?.data.names).toEqual(["one"]);
    await clearActor(alice);
    expect(await getSnapshot(alice, "orders")).toBeNull();
    expect(await listPending(alice)).toEqual([]);
    expect((await getSnapshot<{ names: string[] }>(bob, "orders"))?.data.names).toEqual(["two"]);
    expect(await listPending(bob)).toHaveLength(1);
  });

  it("expires stale cache after eight hours", async () => {
    await saveSnapshot(alice, "orders", [1]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 60 * 60 * 1000 + 1000);
    expect(await getSnapshot(alice, "orders")).toBeNull();
  });
});

describe("offline executor commands", () => {
  it("atomically rejects competing pending commands for the same actor/order", async () => {
    const results = await Promise.allSettled([enqueue(action()), enqueue(action())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await listPending(alice)).toHaveLength(1);
    await enqueue(action("order-a", bob));
    expect(await listPending(bob)).toHaveLength(1);
  });

  it("persists an immutable payload snapshot and rejects unsupported mutations", async () => {
    const input = action();
    const entry = await enqueue(input);
    input.request.expected_version = 99;
    expect((await listPending(alice))[0].request.expected_version).toBe(3);
    await expect(
      enqueue({ ...action("b"), request: { action: "cancel", expected_version: 3 } }),
    ).rejects.toThrow();
    await expect(
      enqueue({ ...action("b"), request: { action: "start", expected_version: 0 } }),
    ).rejects.toThrow();
    await removePending(bob, entry.id);
    expect(await listPending(alice)).toHaveLength(1);
  });

  it("retries an ambiguous response with the exact key/version/body, without duplicate consumption", async () => {
    const queued = await enqueue({
      ...action(),
      request: {
        action: "complete",
        expected_version: 3,
        completion: { materials: [{ material_id: "steel", quantity: "0.125" }] },
      },
    });
    const received: PendingAction[] = [];
    const accepted = new Map<string, unknown>();
    const send = vi.fn(async (entry: PendingAction) => {
      received.push(entry);
      if (!accepted.has(entry.id)) {
        accepted.set(entry.id, entry.request);
        throw new TypeError("response lost after server committed");
      }
      return { status: "completed" };
    });
    expect((await syncPending(alice, send)).offline).toBe(true);
    expect(await listPending(alice)).toHaveLength(1);
    expect((await syncPending(alice, send)).sent).toBe(1);
    expect(await listPending(alice)).toEqual([]);
    expect(received.map((e) => e.id)).toEqual([queued.id, queued.id]);
    expect(received[0].request).toEqual(received[1].request);
    expect(accepted.size).toBe(1);
  });

  it("blocks version conflicts without rebasing, retries only on explicit request", async () => {
    const queued = await enqueue(action());
    const send = vi.fn(async () => {
      throw { status: 409 };
    });
    expect((await syncPending(alice, send)).blocked).toBe(1);
    expect((await listPending(alice))[0].state).toBe("blocked");
    expect((await listPending(alice))[0].request.expected_version).toBe(3);
    await syncPending(alice, send);
    expect(send).toHaveBeenCalledTimes(1);
    const retry = vi.fn(async (entry: PendingAction) => {
      expect(entry.id).toBe(queued.id);
      expect(entry.request.expected_version).toBe(3);
      return {};
    });
    expect((await retryPending(alice, queued.id, retry)).sent).toBe(1);
  });

  it("keeps unsent requests and stops after unauthorized or transient errors", async () => {
    await enqueue(action("a"));
    await enqueue(action("b"));
    const unauthorized = vi.fn(async () => {
      throw { status: 401 };
    });
    expect((await syncPending(alice, unauthorized)).unauthorized).toBe(true);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(await listPending(alice)).toHaveLength(2);
    const limited = vi.fn(async () => {
      throw { status: 429 };
    });
    expect((await syncPending(alice, limited)).offline).toBe(true);
    expect(limited).toHaveBeenCalledTimes(1);
    expect((await listPending(alice)).every((entry) => entry.state === "pending")).toBe(true);
  });

  it("does not resurrect cleared data when an in-flight request fails", async () => {
    await enqueue(action());
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = syncPending(alice, async () => {
      started();
      await pending;
      throw { status: 409 };
    });
    await reached;
    await clearActor(alice);
    release();
    await sync;
    expect(await listPending(alice)).toEqual([]);
  });

  it("serializes simultaneous sync attempts and never sends other actors commands", async () => {
    await enqueue(action());
    await enqueue(action("a", bob));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = vi.fn(async (entry: PendingAction) => {
      expect(entry.actorId).toBe(alice);
      await gate;
    });
    const first = syncPending(alice, sender);
    const second = syncPending(alice, sender);
    release();
    await Promise.all([first, second]);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await listPending(bob)).toHaveLength(1);
  });
});
