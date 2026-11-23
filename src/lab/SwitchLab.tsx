import { useEffect, useState } from "react";
import { switchStats } from "../lib/perfMarks";

/** 目标：相邻切图（预解码命中）不超过 100 ms。 */
const TARGET_MS = 100;

const ms = (v: number) => `${v.toFixed(1)} ms`;

/**
 * 切图耗时：单张视图里每次左右切图记录按键到新图换上后下一帧的时间（最近 200 次）。
 * 先在单张视图里按住方向键或逐张切换，再回到这一页读数。
 */
export default function SwitchLab() {
  const [stats, setStats] = useState(switchStats);
  useEffect(() => {
    const timer = setInterval(() => setStats(switchStats()), 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div>
      <p>用法：返回主界面，打开一个目录并进入单张视图，左右切图若干次（建议 50 次以上），再回到这一页。</p>
      <ul>
        <li>样本数：{stats.count}</li>
        <li>P50：{stats.count ? ms(stats.p50) : "—"}</li>
        <li>
          P95：{stats.count ? ms(stats.p95) : "—"}
          {stats.count > 0 && (stats.p95 <= TARGET_MS ? "（达标）" : `（超过 ${TARGET_MS} ms 目标）`)}
        </li>
        <li>最大：{stats.count ? ms(stats.max) : "—"}</li>
      </ul>
      <p>说明：计时从按键或点击箭头开始，到新内容放进画面后的下一帧为止；到头不换图的按键不计。</p>
      <p>注意：预解码未命中时，样本在缩略图垫底放进画面的下一帧就结束，量的不是原图显示出来的时间。</p>
    </div>
  );
}
