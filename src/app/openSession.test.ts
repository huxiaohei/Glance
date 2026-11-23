import { describe, expect, it } from "vitest";
import type { CatalogEvent, RootInfo } from "../ipc/types";
import { createOpener } from "./openSession";

const info = (generation: number): RootInfo => ({ generation, path: "/r", name: "r", recursive: true, focus: null });
const OK = { superseded: false, error: null };
const done = (generation: number): CatalogEvent => ({ type: "done", generation, total: 0 });

function setup() {
  const log: string[] = [];
  const seqs: number[] = [];
  const pending: { resolve(i: RootInfo): void; reject(e: unknown): void; emit(e: CatalogEvent): void }[] = [];
  const open = createOpener({
    seed: 100,
    openPath: (_p, _r, seq, onEvent) =>
      new Promise<RootInfo>((resolve, reject) => (seqs.push(seq), pending.push({ resolve, reject, emit: onEvent }))),
    begin: (i) => log.push(`begin:${i.generation}`),
    apply: (e) => log.push(`apply:${e.type}:${e.generation}`),
  });
  return { log, pending, seqs, open };
}

describe("createOpener", () => {
  it("openPath 落定前到达的事件在 begin 之后按顺序回放", async () => {
    const { log, pending, open } = setup();
    const p = open("/a", true);
    pending[0].emit({ type: "batch", generation: 1, entries: [] });
    pending[0].emit(done(1));
    pending[0].resolve(info(1));
    expect(await p).toEqual(OK);
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
    expect(await a).toEqual({ superseded: true, error: null });
    pending[0].emit({ type: "dims", generation: 1, items: [] });
    expect(log).toEqual(["begin:2", "apply:done:2"]);
  });

  it("失败时返回错误码且不 begin", async () => {
    const { log, pending, open } = setup();
    const p = open("/a", true);
    pending[0].emit(done(1));
    pending[0].reject({ code: "notFound" });
    expect(await p).toEqual({ superseded: false, error: "notFound" });
    expect(log).toEqual([]);
  });

  it("无法识别的错误归为 unreadable", async () => {
    const { pending, open } = setup();
    const p = open("/a", true);
    pending[0].reject("boom");
    expect(await p).toEqual({ superseded: false, error: "unreadable" });
  });

  it("已 begin 的会话在新调用失败后继续接收事件", async () => {
    const { log, pending, open } = setup();
    const a = open("/a", true);
    pending[0].resolve(info(1));
    await a;
    const b = open("/b", true);
    pending[0].emit({ type: "dims", generation: 1, items: [] }); // B 尚未 begin，A 仍有效
    pending[1].reject({ code: "notFound" });
    expect(await b).toEqual({ superseded: false, error: "notFound" });
    pending[0].emit(done(1));
    expect(log).toEqual(["begin:1", "apply:dims:1", "apply:done:1"]);
  });

  it("B 先 begin 后，尚未 begin 的 A 的结果和事件被忽略", async () => {
    const { log, pending, open } = setup();
    const a = open("/a", true);
    const b = open("/b", true);
    pending[1].resolve(info(2));
    await b;
    pending[0].emit(done(1));
    pending[0].resolve(info(1));
    expect(await a).toEqual({ superseded: true, error: null });
    expect(log).toEqual(["begin:2"]);
  });

  it("B begin 后，A 已 begin 的会话的事件被丢弃", async () => {
    const { log, pending, open } = setup();
    const a = open("/a", true);
    pending[0].resolve(info(1));
    await a;
    const b = open("/b", true);
    pending[1].resolve(info(2));
    await b;
    pending[0].emit(done(1));
    expect(log).toEqual(["begin:1", "begin:2"]);
  });

  it("每次调用带上递增的序号", async () => {
    const { seqs, pending, open } = setup();
    const a = open("/a", true);
    const b = open("/b", true);
    expect(seqs).toEqual([101, 102]);
    pending[0].reject({ code: "notFound" });
    pending[1].reject({ code: "notFound" });
    await Promise.all([a, b]);
  });

  it("后端答复 superseded 时结果为被取代，不 begin 也不报错", async () => {
    const { log, pending, open } = setup();
    const p = open("/a", true);
    pending[0].reject({ code: "superseded" });
    expect(await p).toEqual({ superseded: true, error: null });
    expect(log).toEqual([]);
  });

  it("tag 原样传到 begin", async () => {
    const tags: unknown[] = [];
    const open = createOpener<{ keep: boolean }>({
      seed: 100,
      openPath: async () => info(1),
      begin: (_i, tag) => void tags.push(tag),
      apply: () => {},
    });
    await open("/a", true, { keep: true });
    await open("/a", true);
    expect(tags).toEqual([{ keep: true }, undefined]);
  });
});
