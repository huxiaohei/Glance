import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";
import { errorText, renameTo } from "../../app/fileOps";
import { t } from "../../i18n";
import type { FileId, FsErrorCode } from "../../ipc/types";
import { stopRename, useRename } from "../../stores/rename";
import "./rename.css";

function reason(code: FsErrorCode): string {
  if (code === "exists") return t("rename.err.exists");
  if (code === "invalidName") return t("rename.err.invalid");
  return errorText(code);
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * 原地重命名的输入框。挂载时聚焦并选中扩展名之前的部分；回车或失去焦点提交，Esc 取消。
 * 名字没变或为空等同取消。失败时留在编辑状态，下方显示原因。
 */
export default function RenameInput({ id, name }: { id: FileId; name: string }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<FsErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // 提交进行中；已结束（取消或成功）；仍挂载着。都用 ref：同一轮事件里的回车与失焦也要看到最新值
  const inFlight = useRef(false);
  const finished = useRef(false);
  const mounted = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
    // 只在挂载时选一次：之后条目改名（name 变化）不打断正在进行的输入
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = () => {
    finished.current = true;
    if (useRename.getState().id === id) stopRename();
  };

  const submit = async () => {
    if (inFlight.current || finished.current || !mounted.current) return;
    if (value === "" || value === name) {
      finish();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const code = await renameTo(id, value);
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (code === null) finish();
    else {
      setError(code);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") void submit();
    else if (!inFlight.current) finish();
  };

  return (
    <div className="rename">
      <input
        ref={ref}
        className="rename-input"
        type="text"
        value={value}
        readOnly={busy}
        spellCheck={false}
        autoComplete="off"
        aria-label={t("rename.label")}
        aria-invalid={error !== null ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void submit()}
        onPointerDown={stop}
        onDoubleClick={stop}
      />
      {error !== null && (
        <div className="rename-error" role="alert">
          {reason(error)}
        </div>
      )}
    </div>
  );
}
