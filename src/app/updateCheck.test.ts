import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/api", () => ({ updateCheck: vi.fn(), updateInstall: vi.fn() }));

const { updateCheck, updateInstall } = await import("../ipc/api");
const { UPDATE_DELAY_MS, startUpdateCheck } = await import("./updateCheck");
const { dismissToast, useToast } = await import("../stores/toast");
const { t } = await import("../i18n");

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(updateCheck).mockReset();
  vi.mocked(updateInstall).mockReset();
  dismissToast();
});
afterEach(() => {
  vi.useRealTimers();
  dismissToast();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("startUpdateCheck", () => {
  it("3 秒前不检查，到 3 秒检查一次", async () => {
    vi.mocked(updateCheck).mockResolvedValue(null);
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS - 1);
    expect(updateCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateCheck).toHaveBeenCalledTimes(1);
  });

  it("有新版本时出提示条，带“更新并重启”动作", async () => {
    vi.mocked(updateCheck).mockResolvedValue("0.1.1");
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS);
    const cur = useToast.getState().current;
    expect(cur?.text).toContain("0.1.1");
    expect(cur?.sticky).toBe(true);
    expect(cur?.actions).toHaveLength(1);
    expect(cur?.actions?.[0].label).toBe(t("update.install"));
  });

  it("返回 null 或拒绝时没有提示条", async () => {
    vi.mocked(updateCheck).mockResolvedValue(null);
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS);
    expect(useToast.getState().current).toBeNull();
    vi.mocked(updateCheck).mockRejectedValue({ code: "x" });
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS);
    expect(useToast.getState().current).toBeNull();
  });

  it("点动作调用 updateInstall；失败后提示条变成失败文字，且仍可再点重试", async () => {
    vi.mocked(updateCheck).mockResolvedValue("0.1.1");
    vi.mocked(updateInstall).mockRejectedValue({ code: "updateFailed" });
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS);
    useToast.getState().current?.actions?.[0].run();
    await flush();
    expect(updateInstall).toHaveBeenCalledTimes(1);
    expect(useToast.getState().current?.text).toBe(t("error.updateFailed"));
    expect(useToast.getState().current?.sticky).toBe(true);
    useToast.getState().current?.actions?.[0].run();
    await flush();
    expect(updateInstall).toHaveBeenCalledTimes(2);
  });

  it("安装超过半秒显示“正在更新…”", async () => {
    vi.mocked(updateCheck).mockResolvedValue("0.1.1");
    vi.mocked(updateInstall).mockReturnValue(new Promise(() => {}));
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS);
    useToast.getState().current?.actions?.[0].run();
    await vi.advanceTimersByTimeAsync(600);
    expect(useToast.getState().current?.text).toBe(t("update.installing"));
    expect(useToast.getState().current?.busy).toBe(true);
  });

  it("3 秒内停止后不再检查", async () => {
    const stop = startUpdateCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_DELAY_MS - 1);
    stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(updateCheck).not.toHaveBeenCalled();
  });
});
