import { describe, expect, it } from "vitest";
import { Preloader } from "./preloader";

/** 假图片：decode() 返回可手动 resolve / reject 的 Promise；可模拟 load / error 事件。 */
class FakeImage {
  src = "";
  isConnected = false;
  complete = false;
  naturalWidth = 0;
  decodeCalls = 0;
  private settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
  private listeners = new Map<string, Set<() => void>>();
  decode(): Promise<void> {
    this.decodeCalls++;
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }
  resolve() { this.settle?.resolve(); }
  reject() { this.settle?.reject(new Error("decode failed")); }
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn); }
  fire(type: "load" | "error") {
    this.complete = true;
    if (type === "load") this.naturalWidth = 10;
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

function setup() {
  const created: FakeImage[] = [];
  const p = new Preloader({
    create: () => {
      const img = new FakeImage();
      created.push(img);
      return img as unknown as HTMLImageElement;
    },
  });
  const notified: number[] = [];
  p.subscribe((id) => notified.push(id));
  return { p, created, notified };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Preloader", () => {
  it("want 之后创建图片并解码，就绪后 get 返回 ready 并通知订阅者", async () => {
    const { p, created, notified } = setup();
    expect(p.get(1, "u1")).toBeNull();
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }]);
    expect(created.map((c) => c.src)).toEqual(["u1", "u2"]);
    expect(created.every((c) => c.decodeCalls === 1)).toBe(true);
    expect(p.get(1, "u1")).toEqual({ state: "loading" });
    // url 不符视为没有
    expect(p.get(1, "other")).toBeNull();

    created[0].resolve();
    await tick();
    const got = p.get(1, "u1");
    expect(got?.state).toBe("ready");
    expect(got?.state === "ready" && got.img).toBe(created[0]);
    expect(notified).toEqual([1]);
    // 同一快照对象，供 useSyncExternalStore 比较
    expect(p.get(1, "u1")).toBe(got);

    // 再次 want 同样的集合不重复创建
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }]);
    expect(created.length).toBe(2);
  });

  it("不再想要的条目被丢弃且 src 被清空", () => {
    const { p, created } = setup();
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }, { id: 3, url: "u3" }]);
    p.want([{ id: 2, url: "u2" }, { id: 4, url: "u4" }]);
    expect(created[0].src).toBe("");
    expect(created[1].src).toBe("u2");
    expect(created[2].src).toBe("");
    expect(created[3].src).toBe("u4");
    expect(p.get(1, "u1")).toBeNull();
    expect(p.get(3, "u3")).toBeNull();

    p.clear();
    expect(created.every((c) => c.src === "")).toBe(true);
    expect(p.get(2, "u2")).toBeNull();
  });

  it("retry：失败的一项以同一地址重新加载一次，第二次不再重试", async () => {
    const { p, created, notified } = setup();
    p.want([{ id: 1, url: "u1" }]);
    expect(p.retry(1)).toBe(false);   // 还在加载，不重试
    created[0].reject();
    created[0].fire("error");
    await tick();
    expect(p.retry(1)).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1].src).toBe("u1");
    expect(p.get(1, "u1")).toEqual({ state: "loading" });
    expect(notified.filter((id) => id === 1)).toHaveLength(2);
    // want 同一地址不会再建一个
    p.want([{ id: 1, url: "u1" }]);
    expect(created).toHaveLength(2);
    created[1].reject();
    created[1].fire("error");
    await tick();
    expect(p.get(1, "u1")).toEqual({ state: "error" });
    expect(p.retry(1)).toBe(false);
    expect(p.retry(9)).toBe(false);
  });

  it("解码失败记为 error，不影响其他条目", async () => {
    const { p, created, notified } = setup();
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }]);
    created[0].reject();
    // 加载也失败
    created[0].fire("error");
    await tick();
    expect(p.get(1, "u1")).toEqual({ state: "error" });
    expect(p.get(2, "u2")).toEqual({ state: "loading" });
    created[1].resolve();
    await tick();
    expect(p.get(2, "u2")?.state).toBe("ready");
    expect(notified).toEqual([1, 2]);
  });

  it("decode 被拒绝但图片能加载时记为 ready", async () => {
    const { p, created, notified } = setup();
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }, { id: 3, url: "u3" }]);
    // 拒绝时已加载完成
    created[0].complete = true;
    created[0].naturalWidth = 10;
    created[0].reject();
    // 拒绝时尚未加载完，之后加载成功
    created[1].reject();
    // 拒绝时已是损坏状态
    created[2].complete = true;
    created[2].reject();
    await tick();
    expect(p.get(1, "u1")?.state).toBe("ready");
    expect(p.get(2, "u2")).toEqual({ state: "loading" });
    expect(p.get(3, "u3")).toEqual({ state: "error" });
    created[1].fire("load");
    expect(p.get(2, "u2")?.state).toBe("ready");
    expect(notified.sort()).toEqual([1, 2, 3]);
  });

  it("同一 id 换了 url 视为新条目", async () => {
    const { p, created, notified } = setup();
    p.want([{ id: 1, url: "u1-a" }]);
    created[0].resolve();
    await tick();
    p.want([{ id: 1, url: "u1-b" }]);
    expect(created.length).toBe(2);
    expect(created[0].src).toBe("");
    expect(created[1].src).toBe("u1-b");
    expect(p.get(1, "u1-a")).toBeNull();
    expect(p.get(1, "u1-b")).toEqual({ state: "loading" });
    created[1].resolve();
    await tick();
    expect(p.get(1, "u1-b")?.state).toBe("ready");
    expect(notified).toEqual([1, 1]);
  });

  it("被丢弃的条目迟到的 decode 结果不产生通知", async () => {
    const { p, created, notified } = setup();
    p.want([{ id: 1, url: "u1" }, { id: 2, url: "u2" }]);
    p.want([{ id: 3, url: "u3" }]);
    created[0].resolve();
    created[1].reject();
    created[1].fire("error");
    await tick();
    expect(notified).toEqual([]);
    expect(p.get(1, "u1")).toBeNull();
    // 再次想要同一 url 时重新创建，不复用被丢弃的
    p.want([{ id: 1, url: "u1" }]);
    expect(created.length).toBe(4);
    expect(p.get(1, "u1")).toEqual({ state: "loading" });
  });

  it("丢弃正在画面上的条目时不清空其 src", () => {
    const { p, created } = setup();
    p.want([{ id: 1, url: "u1-a" }]);
    created[0].isConnected = true;
    p.want([{ id: 1, url: "u1-b" }]);
    expect(created[0].src).toBe("u1-a");
    expect(p.get(1, "u1-a")).toBeNull();
  });

  it("取消订阅后不再通知", async () => {
    const { p, created } = setup();
    const seen: number[] = [];
    const off = p.subscribe((id) => seen.push(id));
    off();
    p.want([{ id: 1, url: "u1" }]);
    created[0].resolve();
    await tick();
    expect(seen).toEqual([]);
  });
});
