/** 批量输出目录名是否合法；与后端 `state::settings::batch_dir_name` 的规则一致。 */
const FORBIDDEN = /[/\\:<>"|?*\u0000-\u001f\u007f-\u009f]/;
const MAX_CHARS = 64;

function isReservedWindowsName(name: string): boolean {
  const base = name.split(".")[0].toUpperCase();
  return ["CON", "PRN", "AUX", "NUL"].includes(base) || /^(COM|LPT)[1-9]$/.test(base);
}

export function validBatchDirName(raw: string): boolean {
  const name = raw.trim();
  return (
    name.length > 0 &&
    [...name].length <= MAX_CHARS &&
    !name.startsWith(".") &&
    !name.endsWith(".") &&
    !FORBIDDEN.test(name) &&
    !isReservedWindowsName(name)
  );
}
