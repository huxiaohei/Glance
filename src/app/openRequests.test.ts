import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  fire: null as null | (() => void),
  unlisten: vi.fn(),
}));
vi.mock("../ipc/api", () => ({
  takeOpenRequest: vi.fn(),
  onOpenRequest: vi.fn((h: () => void) => {
    hooks.fire = h;
    return Promise.resolve(hooks.unlisten);
  }),
}));
vi.mock("./openFolder", () => ({ openFolder: vi.fn(() => Promise.resolve(null)) }));

const { startOpenRequests } = await import("./openRequests");
const { takeOpenRequest, onOpenRequest } = await import("../ipc/api");
const { openFolder } = await import("./openFolder");

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startOpenRequests", () => {
  beforeEach(() => {
    hooks.fire = null;
    hooks.unlisten.mockReset();
    vi.mocked(takeOpenRequest).mockReset().mockResolvedValue(null);
    vi.mocked(onOpenRequest).mockClear();
    vi.mocked(openFolder).mockReset().mockResolvedValue(null);
  });

  it("启动时有待处理路径就打开", async () => {
    vi.mocked(takeOpenRequest).mockResolvedValueOnce("/a");
    startOpenRequests();
    await flush();
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledWith("/a");
  });

  it("启动时没有请求不打开", async () => {
    startOpenRequests();
    await flush();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("事件到来再取一次", async () => {
    startOpenRequests();
    await flush();
    vi.mocked(takeOpenRequest).mockResolvedValueOnce("/b");
    hooks.fire!();
    await flush();
    expect(openFolder).toHaveBeenCalledWith("/b");
    expect(openFolder).toHaveBeenCalledTimes(1);
    hooks.fire!();
    await flush();
    expect(openFolder).toHaveBeenCalledTimes(1);
  });

  it("挂两次只打开一次", async () => {
    vi.mocked(takeOpenRequest).mockResolvedValueOnce("/a");
    const stop = startOpenRequests();
    stop();
    startOpenRequests();
    await flush();
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(openFolder).toHaveBeenCalledWith("/a");
  });

  it("注册完成前停止则立刻取消，事件不再取", async () => {
    const stop = startOpenRequests();
    stop();
    await flush();
    expect(hooks.unlisten).toHaveBeenCalledTimes(1);
    const n = vi.mocked(takeOpenRequest).mock.calls.length;
    hooks.fire!();
    await flush();
    expect(vi.mocked(takeOpenRequest).mock.calls.length).toBe(n);
  });

  it("停止后才返回的取结果照常打开", async () => {
    let resolve!: (v: string | null) => void;
    vi.mocked(takeOpenRequest).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const stop = startOpenRequests();
    stop();
    resolve("/late");
    await flush();
    expect(openFolder).toHaveBeenCalledWith("/late");
  });

  it("取与监听失败都吞掉", async () => {
    vi.mocked(takeOpenRequest).mockRejectedValue(new Error("x"));
    vi.mocked(onOpenRequest).mockRejectedValueOnce(new Error("y"));
    expect(() => startOpenRequests()).not.toThrow();
    await flush();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it("openFolder 返回错误码不抛", async () => {
    vi.mocked(takeOpenRequest).mockResolvedValueOnce("/gone");
    vi.mocked(openFolder).mockResolvedValue("notFound");
    expect(() => startOpenRequests()).not.toThrow();
    await flush();
    expect(openFolder).toHaveBeenCalledWith("/gone");
  });
});
