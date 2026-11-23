import { describe, expect, it } from "vitest";
import type { CatalogEvent, RootInfo } from "../ipc/types";
import { createOpener } from "./openSession";

const info = (generation: number): RootInfo => ({ generation, path: "/r", name: "r", recursive: true, focus: null });
const done = (generation: number): CatalogEvent => ({ type: "done", generation, total: 0 });

function setup() {
  const log: string[] = [];
  const pending: { resolve(i: RootInfo): void; reject(e: unknown): void; emit(e: CatalogEvent): void }[] = [];
  const open = createOpener({
    openPath: (_p, _r, onEvent) =>
      new Promise<RootInfo>((resolve, reject) => pending.push({ resolve, reject, emit: onEvent })),
    begin: (i) => log.push(`begin:${i.generation}`),
    apply: (e) => log.push(`apply:${e.type}:${e.generation}`),
  });
  return { log, pending, open };
}

describe("createOpener", () => {
  it("openPath 落定前到达的事件在 begin 之后按顺序回放", async () => {
    const { log, pending, open } = setup();
    const p = open("/a", true);
    pending[0].emit({ type: "batch", generation: 1, entries: [] });
    pending[0].emit(done(1));
    pending[0].resolve(info(1));
    expect(await p).toBeNull();
    pending[0].emit({ type: "dims", generation: 1, items: [] });
    expect(log).toEqual(["begin:1", "apply:batch:1", "apply:done:1", "apply:dims:1"]);
  });

  it("被后一次调用取代的结果和事件都被忽略", async () => {
    const { log, pending, open } = setup();
    const a = open("/a", true);
    const b = open("/b", true);
    pending[1].emit(done(2));
    pending[1].resolve(info(2));
    await b;
    pending[0].emit(done(1));
    pending[0].resolve(info(1));
    await a;
    pending[0].emit({ type: "dims", generation: 1, items: [] });
    expect(log).toEqual(["begin:2", "apply:done:2"]);
  });

  it("失败时返回错误码且不 begin", async () => {
    const { log, pending, open } = setup();
    const p = open("/a", true);
    pending[0].emit(done(1));
    pending[0].reject({ code: "notFound" });
    expect(await p).toBe("notFound");
    expect(log).toEqual([]);
  });

  it("无法识别的错误归为 unreadable", async () => {
    const { pending, open } = setup();
    const p = open("/a", true);
    pending[0].reject("boom");
    expect(await p).toBe("unreadable");
  });
});
