import { useEffect, useState } from "react";
import { switchStats } from "../lib/perfMarks";

/** 目标：相邻切图（预解码命中）不超过 100 ms。 */
const TARGET_MS = 100;

const ms = (v: number) => `${v.toFixed(1)} ms`;

/**
 * 切图耗时：单张视图里每次左右切图记录按键到新内容提交后再过一帧的时间（最近 200 次）。
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
      <p>说明：计时从按键或点击箭头开始，到新内容提交到画面之后的第二帧开始为止（即提交后又过了一帧，那一帧的样式、布局与绘制已完成）；到头不换图的按键不计。</p>
      <p>不含：超大图片的 GPU 上传与光栅化可能晚于这一帧完成，这部分不在样本里。</p>
      <p>注意：预解码未命中时，样本在垫底的缩略图加载完成并画出后就结束，量的不是原图显示出来的时间。</p>
    </div>
  );
}
