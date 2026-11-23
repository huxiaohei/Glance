import { describe, expect, it } from "vitest";

// 需要 vite.config.ts 里 test.css.include 放行 `?raw`，否则内容是空串
const styles = import.meta.glob<string>("./**/*.css", { query: "?raw", import: "default", eager: true });
const themeCss = styles["./theme.css"];

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

/** 取出某个选择器后面第一个 `{…}` 块里的 `--name: value` 声明。 */
function block(css: string, selector: string, from = 0): string {
  const at = css.indexOf(selector, from);
  if (at < 0) throw new Error(`找不到 ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function vars(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

describe("theme", () => {
  it("src 下除 theme.css 和 lab 外的样式文件里没有写死的色值", () => {
    const files = Object.keys(styles).filter((p) => p !== "./theme.css" && !p.startsWith("./lab/"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((p) => COLOR_LITERAL.test(styles[p]));
    expect(offenders).toEqual([]);
  });

  it("浅色主题给 :root 里的每个颜色变量都重新赋了值", () => {
    const root = vars(block(themeCss, ":root {"));
    const colorNames = [...root].filter(([, v]) => COLOR_LITERAL.test(v)).map(([k]) => k).sort();
    expect(colorNames.length).toBeGreaterThan(0);

    const light = [...vars(block(themeCss, ':root[data-theme="light"]')).keys()].sort();
    const media = themeCss.indexOf("@media (prefers-color-scheme: light)");
    expect(media).toBeGreaterThan(0);
    const system = [...vars(block(themeCss, ':root[data-theme="system"]', media)).keys()].sort();

    for (const name of colorNames) expect(light).toContain(name);
    expect(system).toEqual(light);
  });
});
