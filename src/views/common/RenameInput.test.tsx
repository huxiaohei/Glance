// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameTo } from "../../app/fileOps";
import { t } from "../../i18n";
import { startRename, stopRename, useRename } from "../../stores/rename";
import RenameInput from "./RenameInput";

vi.mock("../../app/fileOps", () => ({
  renameTo: vi.fn(),
  errorText: (code: string) => `err:${code}`,
}));

const NAME = "赵云 100%.png";

function setup(name = NAME) {
  useRename.setState({ id: 1 });
  const view = render(<RenameInput id={1} name={name} />);
  const input = view.container.querySelector("input")!;
  return { ...view, input };
}

beforeEach(() => stopRename());
afterEach(() => vi.clearAllMocks());

describe("RenameInput", () => {
  it("挂载后选中扩展名之前的部分", () => {
    const { input } = setup();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(NAME);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(7);
    expect(input.getAttribute("aria-label")).toBe(t("rename.label"));
  });

  it("没有扩展名时全选", () => {
    const { input } = setup("README");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
  });

  it("回车以新名字调用 renameTo，成功后退出编辑", async () => {
    vi.mocked(renameTo).mockResolvedValue(null);
    const { input } = setup();
    fireEvent.change(input, { target: { value: "关羽.png" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(renameTo).toHaveBeenCalledWith(1, "关羽.png");
    expect(useRename.getState().id).toBeNull();
  });

  it("名字没变或为空时不调用后端，直接退出", async () => {
    const { input } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useRename.getState().id).toBeNull();

    const b = setup();
    fireEvent.change(b.input, { target: { value: "" } });
    fireEvent.keyDown(b.input, { key: "Enter" });
    expect(useRename.getState().id).toBeNull();
    expect(renameTo).not.toHaveBeenCalled();
  });

  it("Esc 取消，不调用后端", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(renameTo).not.toHaveBeenCalled();
    expect(useRename.getState().id).toBeNull();
  });

  it("失去焦点时提交", async () => {
    vi.mocked(renameTo).mockResolvedValue(null);
    const { input } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(renameTo).toHaveBeenCalledWith(1, "x.png");
    expect(useRename.getState().id).toBeNull();
  });

  it("失败时留在编辑状态并显示原因，输入内容保留", async () => {
    vi.mocked(renameTo).mockResolvedValueOnce("exists").mockResolvedValueOnce("invalidName").mockResolvedValueOnce("denied");
    const { input, getByRole, queryByRole } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(useRename.getState().id).toBe(1);
    expect(input.value).toBe("x.png");
    expect(input.readOnly).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(getByRole("alert").textContent).toBe(t("rename.err.exists"));

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(getByRole("alert").textContent).toBe(t("rename.err.invalid"));
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(getByRole("alert").textContent).toBe("err:denied");

    // 再次输入时原因消失
    fireEvent.change(input, { target: { value: "y.png" } });
    expect(queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("提交未返回时再按回车不重复请求", async () => {
    let resolve!: (v: null) => void;
    vi.mocked(renameTo).mockReturnValue(new Promise((r) => (resolve = r)));
    const { input } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.readOnly).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(renameTo).toHaveBeenCalledTimes(1);
    await act(async () => resolve(null));
    expect(useRename.getState().id).toBeNull();
  });

  it("卸载时不提交，并结束这次编辑", async () => {
    const { input, unmount } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    unmount();
    await act(async () => {});
    expect(renameTo).not.toHaveBeenCalled();
    expect(useRename.getState().id).toBeNull();
  });

  it("提交进行中卸载：提交返回后编辑已结束，不留下旧的编辑状态", async () => {
    let resolve!: (v: null) => void;
    vi.mocked(renameTo).mockReturnValue(new Promise((r) => (resolve = r)));
    const { input, unmount } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    fireEvent.keyDown(input, { key: "Enter" });
    unmount();
    await act(async () => resolve(null));
    expect(renameTo).toHaveBeenCalledTimes(1);
    expect(useRename.getState().id).toBeNull();
  });

  it("StrictMode 下挂载后编辑保持打开", async () => {
    useRename.setState({ id: 1 });
    const { container } = render(
      <StrictMode>
        <RenameInput id={1} name={NAME} />
      </StrictMode>,
    );
    await act(async () => {});
    const input = container.querySelector("input");
    expect(useRename.getState().id).toBe(1);
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("卸载后同一张图重新开始的编辑不被旧实例的延迟清理结束", async () => {
    const { unmount } = setup();
    unmount();
    startRename(1);
    await act(async () => {});
    expect(useRename.getState().id).toBe(1);
  });

  it("组字期间的回车不提交", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "x.png" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(renameTo).not.toHaveBeenCalled();
    expect(useRename.getState().id).toBe(1);
  });

  it("pointerdown 与 dblclick 不冒泡；回车与 Esc 不传到外层", () => {
    const outer = { pointerDown: vi.fn(), dblClick: vi.fn(), keyDown: vi.fn() };
    useRename.setState({ id: 1 });
    const { getByRole } = render(
      <div onPointerDown={outer.pointerDown} onDoubleClick={outer.dblClick} onKeyDown={outer.keyDown}>
        <RenameInput id={1} name={NAME} />
      </div>,
    );
    const input = getByRole("textbox");
    fireEvent.pointerDown(input);
    fireEvent.doubleClick(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer.pointerDown).not.toHaveBeenCalled();
    expect(outer.dblClick).not.toHaveBeenCalled();
    expect(outer.keyDown).not.toHaveBeenCalled();
  });
});
