// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Modal({ open, empty = false }: { open: boolean; empty?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, open);
  if (!open) return null;
  return (
    <div ref={ref} tabIndex={-1} data-testid="box">
      {!empty && (
        <>
          <button type="button">a</button>
          <select aria-label="s">
            <option>x</option>
          </select>
          <button type="button" disabled>
            off
          </button>
          <button type="button">b</button>
        </>
      )}
    </div>
  );
}

function Page({ open, showOpener = true, empty }: { open: boolean; showOpener?: boolean; empty?: boolean }) {
  return (
    <>
      {showOpener && <button type="button">opener</button>}
      <Modal open={open} empty={empty} />
    </>
  );
}

const btn = (name: string) => screen.getByRole("button", { name });

describe("useModalFocus", () => {
  it("打开时焦点进入容器内第一个可聚焦元素", () => {
    const { rerender } = render(<Page open={false} />);
    btn("opener").focus();
    rerender(<Page open />);
    expect(document.activeElement).toBe(btn("a"));
  });

  it("容器内没有可聚焦元素时焦点落在容器本身", () => {
    const { rerender } = render(<Page open={false} empty />);
    rerender(<Page open empty />);
    expect(document.activeElement).toBe(screen.getByTestId("box"));
  });

  it("最后一个元素上按 Tab 回到第一个；第一个上按 Shift+Tab 到最后一个", () => {
    const { rerender } = render(<Page open={false} />);
    rerender(<Page open />);
    btn("b").focus();
    fireEvent.keyDown(btn("b"), { key: "Tab" });
    expect(document.activeElement).toBe(btn("a"));
    fireEvent.keyDown(btn("a"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(btn("b"));
  });

  it("关闭后焦点回到打开前的元素", () => {
    const { rerender } = render(<Page open={false} />);
    btn("opener").focus();
    rerender(<Page open />);
    expect(document.activeElement).toBe(btn("a"));
    rerender(<Page open={false} />);
    expect(document.activeElement).toBe(btn("opener"));
  });

  it("打开前的元素已被移除时不抛错", () => {
    const { rerender } = render(<Page open={false} />);
    btn("opener").focus();
    rerender(<Page open />);
    rerender(<Page open showOpener={false} />);
    expect(() => rerender(<Page open={false} showOpener={false} />)).not.toThrow();
  });
});
