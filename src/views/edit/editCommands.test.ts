// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editClose, editOpen, editParamsGet, editPreview, editResultUrl } from "../../ipc/api";
import { useCatalog } from "../../stores/catalog";
import { useEditUi } from "../../stores/editUi";
import { useNav } from "../../stores/nav";
import { registerEditCommands } from "./editCommands";

vi.mock("../../ipc/api");

let off: (() => void) | null = null;
beforeEach(() => {
  vi.mocked(editParamsGet).mockRejectedValue("none");
  vi.mocked(editOpen).mockResolvedValue({
    session: 7, width: 10, height: 10, proxyW: 10, proxyH: 10, srcFormat: "jpeg", hasAlpha: false, fileSize: 1,
  });
  vi.mocked(editClose).mockResolvedValue();
  vi.mocked(editPreview).mockResolvedValue(null);
  vi.mocked(editResultUrl).mockReturnValue("glance://x");
  useCatalog.getState().reset();
  useCatalog.getState().begin({ generation: 1, path: "/p", name: "p", recursive: true, focus: null });
  useNav.getState().reset();
  useNav.getState().openSingle(2);
  off = registerEditCommands();
});
afterEach(() => {
  off?.();
  off = null;
  useEditUi.getState().close();
  vi.clearAllMocks();
});

describe("编辑会话的收尾", () => {
  it("pagehide_closes_edit_session", async () => {
    await useEditUi.getState().open(2);
    expect(useEditUi.getState().status).toBe("ready");
    window.dispatchEvent(new Event("pagehide"));
    expect(editClose).toHaveBeenCalledWith(7);
    expect(useEditUi.getState().status).toBe("idle");
  });

  it("保存进行中 pagehide 不关会话", async () => {
    await useEditUi.getState().open(2);
    useEditUi.setState({ status: "saving" });
    window.dispatchEvent(new Event("pagehide"));
    expect(editClose).not.toHaveBeenCalled();
  });

  it("注销后 pagehide 不再关会话", async () => {
    off?.();
    off = null;
    await useEditUi.getState().open(2);
    window.dispatchEvent(new Event("pagehide"));
    expect(editClose).not.toHaveBeenCalled();
  });
});
