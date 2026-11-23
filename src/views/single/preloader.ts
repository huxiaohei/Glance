import type { FileId } from "../../ipc/types";

export type Loaded = { state: "ready"; img: HTMLImageElement } | { state: "loading" } | { state: "error" };

export interface PreloaderDeps { create(url: string): HTMLImageElement }   // 测试里注入假的 Image

const defaultDeps: PreloaderDeps = { create: () => new Image() };

interface Entry { url: string; img: HTMLImageElement; loaded: Loaded; cleanup: (() => void) | null }

const LOADING: Loaded = { state: "loading" };
const ERROR: Loaded = { state: "error" };

/**
 * 预解码：为想要的每张图创建一个 Image 并 decode()，就绪后交出已解码的元素，单张视图直接把它
 * 放进画面。每个 id 至多一个条目；url 里带文件版本，内容变化即视为新条目。
 */
export class Preloader {
  private readonly deps: PreloaderDeps;
  private readonly entries = new Map<FileId, Entry>();
  private readonly listeners = new Set<(id: FileId) => void>();

  constructor(deps: PreloaderDeps = defaultDeps) {
    this.deps = deps;
  }

  /** 整体替换想要的集合：不在其中的丢弃（不在文档里的清空其 src 以中止下载）；新出现的创建 Image、赋 src、调用 decode()。
   *  同一 id 的 url 变了（内容变化）视为新条目。 */
  want(items: { id: FileId; url: string }[]): void {
    const wanted = new Map(items.map((it) => [it.id, it.url] as const));
    for (const [id, e] of this.entries) {
      if (wanted.get(id) !== e.url) this.drop(id, e);
    }
    for (const { id, url } of items) {
      if (!this.entries.has(id)) this.start(id, url);
    }
  }

  get(id: FileId, url: string): Loaded | null {
    const e = this.entries.get(id);
    return e && e.url === url ? e.loaded : null;
  }

  /** 某一项就绪或失败时通知。 */
  subscribe(fn: (id: FileId) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  clear(): void {
    for (const [id, e] of this.entries) this.drop(id, e);
  }

  private start(id: FileId, url: string): void {
    const img = this.deps.create(url);
    const entry: Entry = { url, img, loaded: LOADING, cleanup: null };
    this.entries.set(id, entry);
    img.src = url;

    const settle = (loaded: Loaded) => {
      if (this.entries.get(id) !== entry || entry.loaded !== LOADING) return;
      entry.cleanup?.();
      entry.cleanup = null;
      entry.loaded = loaded;
      for (const fn of [...this.listeners]) fn(id);
    };
    const ready: Loaded = { state: "ready", img };

    // decode() 被拒绝不一定读不出：有的格式引擎解码接口不支持，<img> 仍能显示。
    // 此时以加载结果为准：已加载完成看自然宽度，还在加载则等 load / error
    const onRejected = () => {
      if (this.entries.get(id) !== entry) return;
      if (img.complete) {
        settle(img.naturalWidth > 0 ? ready : ERROR);
        return;
      }
      const onLoad = () => settle(ready);
      const onError = () => settle(ERROR);
      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
      entry.cleanup = () => {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      };
    };
    // 没有 decode() 的环境同样按加载结果判断
    let decoding: Promise<void>;
    try {
      decoding = img.decode();
    } catch (err) {
      decoding = Promise.reject(err);
    }
    decoding.then(() => settle(ready), onRejected);
  }

  private drop(id: FileId, e: Entry): void {
    this.entries.delete(id);
    e.cleanup?.();
    e.cleanup = null;
    // 还在画面上的（被改写的当前图在新版本解码前继续显示）不清空，由画面移除后回收
    if (!e.img.isConnected) e.img.src = "";
  }
}
