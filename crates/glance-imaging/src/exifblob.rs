//! 就地改写 EXIF 的 TIFF 结构：方向归一、像素尺寸与实际一致、摘掉缩略图。
//! 只改固定位置的几个内联值，其余字节原样保留（MakerNote、GPS 等不解析）。

use std::collections::HashSet;

/// EXIF 块上限（与读取侧一致）。
const MAX_EXIF: usize = 1 << 20;

pub(crate) const TAG_IMAGE_WIDTH: u16 = 0x0100;
pub(crate) const TAG_IMAGE_LENGTH: u16 = 0x0101;
pub(crate) const TAG_ORIENTATION: u16 = 0x0112;
pub(crate) const TAG_EXIF_IFD: u16 = 0x8769;
pub(crate) const TAG_GPS_IFD: u16 = 0x8825;
pub(crate) const TAG_PIXEL_X: u16 = 0xA002;
pub(crate) const TAG_PIXEL_Y: u16 = 0xA003;
const TAG_INTEROP_IFD: u16 = 0xA005;
pub(crate) const TAG_THUMB_OFFSET: u16 = 0x0201;
pub(crate) const TAG_THUMB_LENGTH: u16 = 0x0202;

const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;

#[derive(Clone, Copy)]
struct Reader<'a> {
    buf: &'a [u8],
    big: bool,
}

impl Reader<'_> {
    fn u16(&self, pos: usize) -> Option<u16> {
        let b: [u8; 2] = self.buf.get(pos..pos.checked_add(2)?)?.try_into().ok()?;
        Some(if self.big {
            u16::from_be_bytes(b)
        } else {
            u16::from_le_bytes(b)
        })
    }

    fn u32(&self, pos: usize) -> Option<u32> {
        let b: [u8; 4] = self.buf.get(pos..pos.checked_add(4)?)?.try_into().ok()?;
        Some(if self.big {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    }
}

struct Entry {
    tag: u16,
    typ: u16,
    count: u32,
    /// 条目里 4 字节值域的位置。
    value_pos: usize,
}

fn type_size(typ: u16) -> usize {
    match typ {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

/// 读一个目录：做越界与成环检查，把目录自身与外置数据的区间记进 `refs`。
/// 目录偏移小于 8（落在 TIFF 头里）、越界或已读过都返回 `None`。
/// 成功时返回条目与“下一个目录”指针所在的位置。
fn scan_ifd(
    r: Reader,
    off: usize,
    visited: &mut HashSet<usize>,
    refs: &mut Vec<(usize, usize)>,
) -> Option<(Vec<Entry>, usize)> {
    if off < 8 || !visited.insert(off) {
        return None;
    }
    let n = r.u16(off)? as usize;
    let end = off.checked_add(2 + n * 12 + 4)?;
    if end > r.buf.len() {
        return None;
    }
    refs.push((off, end));
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let pos = off + 2 + i * 12;
        let typ = r.u16(pos + 2)?;
        let count = r.u32(pos + 4)?;
        let value_pos = pos + 8;
        let size = (count as u64) * type_size(typ) as u64;
        if size > 4 {
            let start = r.u32(value_pos)? as usize;
            let stop = start.checked_add(usize::try_from(size).ok()?)?;
            if stop > r.buf.len() {
                return None;
            }
            refs.push((start, stop));
        }
        out.push(Entry {
            tag: r.u16(pos)?,
            typ,
            count,
            value_pos,
        });
    }
    Some((out, end - 4))
}

fn find(entries: &[Entry], tag: u16) -> Option<&Entry> {
    entries.iter().find(|e| e.tag == tag)
}

/// 子目录指针：类型必须是 LONG、数量 1。返回目录偏移。
fn sub_ifd(r: Reader, entries: &[Entry], tag: u16) -> Option<Option<usize>> {
    match find(entries, tag) {
        None => Some(None),
        Some(e) if e.typ == TYPE_LONG && e.count == 1 => Some(Some(r.u32(e.value_pos)? as usize)),
        Some(_) => None,
    }
}

/// 把内联的 SHORT / LONG 值改成 `value`，按原类型写回。别的类型、数量或放不下 → None。
fn set_inline(buf: &mut [u8], big: bool, e: &Entry, value: u32) -> Option<()> {
    if e.count != 1 {
        return None;
    }
    let dst = buf.get_mut(e.value_pos..e.value_pos + 4)?;
    match e.typ {
        TYPE_SHORT => {
            let v = u16::try_from(value).ok()?;
            dst[..2].copy_from_slice(&if big {
                v.to_be_bytes()
            } else {
                v.to_le_bytes()
            });
        }
        TYPE_LONG => {
            dst.copy_from_slice(&if big {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            });
        }
        _ => return None,
    }
    Some(())
}

/// 就地改写 EXIF 的 TIFF 结构（不含 `Exif\0\0` 前缀），返回改写后的副本：
/// 方向改成 1，IFD0 的 ImageWidth / ImageLength 与 Exif 子目录的
/// PixelXDimension / PixelYDimension 改成 `width` / `height`（存在才改，按原类型内联写回），
/// 并解除 IFD1 的链接；缩略图数据若恰好在整块末尾且不与其他数据交叠，一并截掉，
/// 截不掉的就地清零（与仍被引用的数据交叠时返回 `None`）。IFD1 本身读不出时当作没有缩略图。
/// 其余字节（MakerNote、GPS 等）原样保留。
/// IFD0 / Exif / GPS / 互操作目录结构有问题（越界、成环）、超过 1 MB、字节序标记不对，
/// 或尺寸写不进字段时返回 `None`，
/// 调用方应改为不带 EXIF 输出，而不是报错。
pub fn normalize_exif(tiff: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    if tiff.len() < 8 || tiff.len() > MAX_EXIF {
        return None;
    }
    let big = match &tiff[..4] {
        b"II*\0" => false,
        b"MM\0*" => true,
        _ => return None,
    };
    let r = Reader { buf: tiff, big };
    let mut visited = HashSet::new();
    // IFD0、Exif、GPS、互操作目录及其外置数据占的区间。
    let mut refs: Vec<(usize, usize)> = Vec::new();

    let ifd0_off = r.u32(4)? as usize;
    let (ifd0, next_pos) = scan_ifd(r, ifd0_off, &mut visited, &mut refs)?;
    let ifd1_off = r.u32(next_pos)? as usize;

    let mut exif = Vec::new();
    if let Some(off) = sub_ifd(r, &ifd0, TAG_EXIF_IFD)? {
        exif = scan_ifd(r, off, &mut visited, &mut refs)?.0;
        if let Some(off) = sub_ifd(r, &exif, TAG_INTEROP_IFD)? {
            scan_ifd(r, off, &mut visited, &mut refs)?;
        }
    }
    if let Some(off) = sub_ifd(r, &ifd0, TAG_GPS_IFD)? {
        scan_ifd(r, off, &mut visited, &mut refs)?;
    }

    // IFD1 只用来找缩略图：能截掉就截掉，截不掉就清零。
    // IFD1 本身读不出（偏移越界、成环）时当作没有缩略图，其余照常保留。
    let mut cut = None;
    let mut zero = None;
    let ifd1 = if ifd1_off != 0 {
        scan_ifd(r, ifd1_off, &mut visited, &mut Vec::new()).map(|(entries, _)| entries)
    } else {
        None
    };
    if let Some(ifd1) = ifd1
        && let (Some(o), Some(l)) = (find(&ifd1, TAG_THUMB_OFFSET), find(&ifd1, TAG_THUMB_LENGTH))
        && o.typ == TYPE_LONG
        && l.typ == TYPE_LONG
        && o.count == 1
        && l.count == 1
    {
        let (to, tl) = (r.u32(o.value_pos)? as usize, r.u32(l.value_pos)? as usize);
        let stop = to.checked_add(tl);
        if stop == Some(tiff.len()) {
            let at = ifd1_off.min(to);
            if refs.iter().all(|&(_, end)| end <= at) {
                cut = Some(at);
            }
        }
        if cut.is_none()
            && let Some(stop) = stop.filter(|&s| s <= tiff.len())
        {
            // 与 TIFF 头或仍被引用的数据交叠：清零会弄坏它们，宁可整块不要。
            let overlaps = |&(a, b): &(usize, usize)| a < stop && to < b;
            if overlaps(&(0, 8)) || refs.iter().any(overlaps) {
                return None;
            }
            zero = Some(to..stop);
        }
    }

    let mut out = tiff.to_vec();
    let edits = [
        (&ifd0, TAG_ORIENTATION, 1),
        (&ifd0, TAG_IMAGE_WIDTH, width),
        (&ifd0, TAG_IMAGE_LENGTH, height),
        (&exif, TAG_PIXEL_X, width),
        (&exif, TAG_PIXEL_Y, height),
    ];
    for (entries, tag, value) in edits {
        if let Some(e) = find(entries, tag) {
            set_inline(&mut out, big, e, value)?;
        }
    }
    out[next_pos..next_pos + 4].fill(0);
    if let Some(at) = cut {
        out.truncate(at);
    }
    if let Some(range) = zero {
        out[range].fill(0);
    }
    Some(out)
}

#[cfg(test)]
/// 测试用的 EXIF 构造与读取，供本 crate 其他模块的测试共用。
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// 测试用条目：值已按字节序编码；超过 4 字节的放外置数据区。
    pub(crate) struct E {
        pub(crate) tag: u16,
        pub(crate) typ: u16,
        pub(crate) count: u32,
        pub(crate) data: Vec<u8>,
    }

    pub(crate) fn w16(be: bool, v: u16) -> [u8; 2] {
        if be { v.to_be_bytes() } else { v.to_le_bytes() }
    }
    pub(crate) fn w32(be: bool, v: u32) -> [u8; 4] {
        if be { v.to_be_bytes() } else { v.to_le_bytes() }
    }

    pub(crate) fn short(be: bool, tag: u16, v: u16) -> E {
        E {
            tag,
            typ: 3,
            count: 1,
            data: w16(be, v).to_vec(),
        }
    }
    pub(crate) fn long(be: bool, tag: u16, v: u32) -> E {
        E {
            tag,
            typ: 4,
            count: 1,
            data: w32(be, v).to_vec(),
        }
    }
    pub(crate) fn ascii(tag: u16, s: &str) -> E {
        let mut d = s.as_bytes().to_vec();
        d.push(0);
        E {
            tag,
            typ: 2,
            count: d.len() as u32,
            data: d,
        }
    }
    pub(crate) fn undef(tag: u16, d: Vec<u8>) -> E {
        E {
            tag,
            typ: 7,
            count: d.len() as u32,
            data: d,
        }
    }
    pub(crate) fn rationals(be: bool, tag: u16, v: &[(u32, u32)]) -> E {
        let mut d = Vec::new();
        for &(a, b) in v {
            d.extend(w32(be, a));
            d.extend(w32(be, b));
        }
        E {
            tag,
            typ: 5,
            count: v.len() as u32,
            data: d,
        }
    }

    pub(crate) fn ifd_size(n: usize) -> usize {
        2 + 12 * n + 4
    }

    /// 写一个目录；外置数据追加到 `data`，其偏移从 `data_base` 起算。
    pub(crate) fn put_ifd(
        be: bool,
        out: &mut Vec<u8>,
        entries: &[E],
        data_base: usize,
        data: &mut Vec<u8>,
        next: u32,
    ) {
        out.extend(w16(be, entries.len() as u16));
        for e in entries {
            out.extend(w16(be, e.tag));
            out.extend(w16(be, e.typ));
            out.extend(w32(be, e.count));
            if e.data.len() <= 4 {
                let mut v = e.data.clone();
                v.resize(4, 0);
                out.extend(v);
            } else {
                out.extend(w32(be, (data_base + data.len()) as u32));
                data.extend(&e.data);
                if data.len() % 2 == 1 {
                    data.push(0);
                }
            }
        }
        out.extend(w32(be, next));
    }

    /// 布局：头、IFD0、Exif、GPS、外置数据、IFD1、缩略图、（可选）尾部杂字节。
    pub(crate) fn build(
        be: bool,
        mut ifd0: Vec<E>,
        exif: Vec<E>,
        gps: Vec<E>,
        thumb: Option<(Vec<u8>, bool)>,
    ) -> Vec<u8> {
        let ifd0_off = 8;
        let n0 = ifd0.len() + usize::from(!exif.is_empty()) + usize::from(!gps.is_empty());
        let exif_off = ifd0_off + ifd_size(n0);
        let gps_off = exif_off
            + if exif.is_empty() {
                0
            } else {
                ifd_size(exif.len())
            };
        let data_base = gps_off
            + if gps.is_empty() {
                0
            } else {
                ifd_size(gps.len())
            };
        if !exif.is_empty() {
            ifd0.push(long(be, TAG_EXIF_IFD, exif_off as u32));
        }
        if !gps.is_empty() {
            ifd0.push(long(be, TAG_GPS_IFD, gps_off as u32));
        }
        ifd0.sort_by_key(|e| e.tag);

        // 先把外置数据算出来，才知道 IFD1 的位置。
        let mut data = Vec::new();
        let (mut b0, mut b1, mut b2) = (Vec::new(), Vec::new(), Vec::new());
        // 临时占位的 next，写完 data 后再回填。
        put_ifd(be, &mut b0, &ifd0, data_base, &mut data, 0);
        put_ifd(be, &mut b1, &exif, data_base, &mut data, 0);
        put_ifd(be, &mut b2, &gps, data_base, &mut data, 0);
        let ifd1_off = data_base + data.len();

        let mut out = Vec::new();
        out.extend(if be { b"MM\0*" } else { b"II*\0" });
        out.extend(w32(be, ifd0_off as u32));
        let next_pos = b0.len() - 4;
        if thumb.is_some() {
            b0[next_pos..].copy_from_slice(&w32(be, ifd1_off as u32));
        }
        out.extend(b0);
        if !exif.is_empty() {
            out.extend(b1);
        }
        if !gps.is_empty() {
            out.extend(b2);
        }
        out.extend(&data);
        if let Some((jpeg, at_end)) = thumb {
            let thumb_off = ifd1_off + ifd_size(2);
            let ifd1 = [
                long(be, TAG_THUMB_OFFSET, thumb_off as u32),
                long(be, TAG_THUMB_LENGTH, jpeg.len() as u32),
            ];
            let mut none = Vec::new();
            put_ifd(be, &mut out, &ifd1, 0, &mut none, 0);
            out.extend(&jpeg);
            if !at_end {
                out.extend([0xAA; 8]);
            }
        }
        out
    }

    pub(crate) fn read(b: &[u8]) -> exif::Exif {
        exif::Reader::new().read_raw(b.to_vec()).unwrap()
    }

    pub(crate) fn uint(x: &exif::Exif, tag: exif::Tag, ifd: exif::In) -> Option<u32> {
        x.get_field(tag, ifd)?.value.get_uint(0)
    }

    /// 从 JPEG 文件里读出 EXIF（没有或读不出则 panic）。
    pub(crate) fn exif_of_jpeg(bytes: &[u8]) -> exif::Exif {
        exif::Reader::new()
            .read_from_container(&mut std::io::Cursor::new(bytes))
            .unwrap()
    }

    /// 带 Make、方向 6、拍摄时间、GPS 纬度、像素尺寸 4000×3000 的小端 EXIF。
    pub(crate) fn sample() -> Vec<u8> {
        let be = false;
        build(
            be,
            vec![
                ascii(0x010F, "Acme"),
                short(be, TAG_ORIENTATION, 6),
                long(be, TAG_IMAGE_WIDTH, 4000),
                long(be, TAG_IMAGE_LENGTH, 3000),
            ],
            vec![
                ascii(0x9003, "2024:05:06 07:08:09"),
                long(be, TAG_PIXEL_X, 4000),
                long(be, TAG_PIXEL_Y, 3000),
            ],
            vec![
                ascii(1, "N"),
                rationals(be, 2, &[(40, 1), (26, 1), (46, 1)]),
            ],
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn orientation_becomes_1() {
        for be in [false, true] {
            let b = build(
                be,
                vec![short(be, TAG_ORIENTATION, 6), ascii(0x010F, "Cam")],
                vec![],
                vec![],
                None,
            );
            assert_eq!(
                uint(&read(&b), exif::Tag::Orientation, exif::In::PRIMARY),
                Some(6)
            );
            let out = normalize_exif(&b, 10, 10).unwrap();
            assert_eq!(
                uint(&read(&out), exif::Tag::Orientation, exif::In::PRIMARY),
                Some(1)
            );
        }
    }

    #[test]
    fn pixel_dims_rewritten() {
        for be in [false, true] {
            let exif = vec![long(be, TAG_PIXEL_X, 4000), short(be, TAG_PIXEL_Y, 3000)];
            let b = build(
                be,
                vec![
                    long(be, TAG_IMAGE_WIDTH, 4000),
                    short(be, TAG_IMAGE_LENGTH, 3000),
                ],
                exif,
                vec![],
                None,
            );
            let out = normalize_exif(&b, 3000, 2000).unwrap();
            let x = read(&out);
            assert_eq!(
                uint(&x, exif::Tag::PixelXDimension, exif::In::PRIMARY),
                Some(3000)
            );
            assert_eq!(
                uint(&x, exif::Tag::PixelYDimension, exif::In::PRIMARY),
                Some(2000)
            );
            assert_eq!(
                uint(&x, exif::Tag::ImageWidth, exif::In::PRIMARY),
                Some(3000)
            );
            assert_eq!(
                uint(&x, exif::Tag::ImageLength, exif::In::PRIMARY),
                Some(2000)
            );
        }
    }

    #[test]
    fn dims_that_do_not_fit_drop_exif() {
        let b = build(
            false,
            vec![],
            vec![short(false, TAG_PIXEL_X, 100)],
            vec![],
            None,
        );
        assert!(normalize_exif(&b, 70000, 10).is_none());
        assert!(normalize_exif(&b, 65535, 10).is_some());
        let b = build(false, vec![], vec![ascii(TAG_PIXEL_X, "1")], vec![], None);
        assert!(normalize_exif(&b, 10, 10).is_none());
        // 数量不是 1 也不行。
        let mut e = short(false, TAG_PIXEL_X, 5);
        e.count = 2;
        let b = build(false, vec![], vec![e], vec![], None);
        assert!(normalize_exif(&b, 10, 10).is_none());
    }

    #[test]
    fn gps_and_makernote_bytes_untouched() {
        let be = false;
        let maker: Vec<u8> = (0..64u8).collect();
        let lat = [(40, 1), (26, 1), (46, 1)];
        let gps = vec![ascii(1, "N"), rationals(be, 2, &lat)];
        let exif = vec![short(be, TAG_PIXEL_X, 100), undef(0x927C, maker.clone())];
        let b = build(be, vec![short(be, TAG_ORIENTATION, 8)], exif, gps, None);
        let out = normalize_exif(&b, 50, 50).unwrap();
        assert_eq!(out.len(), b.len());
        let find_sub =
            |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).position(|w| w == needle);
        let pos = find_sub(&b, &maker).unwrap();
        assert_eq!(&out[pos..pos + 64], &maker[..]);
        // GPS 纬度的有理数区原样。
        let lat_bytes: Vec<u8> = lat
            .iter()
            .flat_map(|&(a, c)| [w32(be, a), w32(be, c)].concat())
            .collect();
        let pos = find_sub(&b, &lat_bytes).unwrap();
        assert_eq!(&out[pos..pos + lat_bytes.len()], &lat_bytes[..]);
        let x = read(&out);
        let f = x
            .get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
            .unwrap();
        match &f.value {
            exif::Value::Rational(v) => assert_eq!(v[0].num, 40),
            _ => panic!("lat type"),
        }
    }

    #[test]
    fn thumbnail_unlinked_and_truncated() {
        let jpeg = vec![0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9];
        let ifd0 = || vec![ascii(0x010F, "Cam")];

        let b = build(false, ifd0(), vec![], vec![], Some((jpeg.clone(), true)));
        assert!(read(&b).fields().any(|f| f.ifd_num == exif::In::THUMBNAIL));
        let out = normalize_exif(&b, 10, 10).unwrap();
        assert!(out.len() < b.len());
        assert!(
            !read(&out)
                .fields()
                .any(|f| f.ifd_num == exif::In::THUMBNAIL)
        );
        assert!(
            read(&out)
                .get_field(exif::Tag::Make, exif::In::PRIMARY)
                .is_some()
        );

        let b = build(false, ifd0(), vec![], vec![], Some((jpeg.clone(), false)));
        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), b.len());
        assert!(
            !read(&out)
                .fields()
                .any(|f| f.ifd_num == exif::In::THUMBNAIL)
        );
        // 截不掉的缩略图字节清零。
        let at = b.windows(jpeg.len()).position(|w| w == jpeg).unwrap();
        assert!(out[at..at + jpeg.len()].iter().all(|&x| x == 0));
    }

    #[test]
    fn thumbnail_that_cannot_be_truncated_is_zeroed() {
        let be = false;
        let jpeg = vec![0xFF, 0xD8, 9, 8, 7, 6, 5, 4, 0xFF, 0xD9];
        let gps = vec![
            ascii(1, "N"),
            rationals(be, 2, &[(40, 1), (26, 1), (46, 1)]),
        ];
        let mut b = build(
            be,
            vec![ascii(0x010F, "Acme")],
            vec![],
            gps,
            Some((jpeg.clone(), true)),
        );
        b.extend([0x5A; 16]);
        let at = b.windows(jpeg.len()).position(|w| w == jpeg).unwrap();

        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), b.len());
        assert!(out[at..at + jpeg.len()].iter().all(|&x| x == 0));
        assert_eq!(&out[b.len() - 16..], &[0x5A; 16]);
        let x = read(&out);
        assert!(!x.fields().any(|f| f.ifd_num == exif::In::THUMBNAIL));
        assert!(x.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        assert!(
            x.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
                .is_some()
        );
    }

    #[test]
    fn thumbnail_overlapping_referenced_data_drops_exif() {
        let maker: Vec<u8> = (0..64u8).collect();
        let exif = vec![short(false, TAG_PIXEL_X, 100), undef(0x927C, maker.clone())];
        let mut b = build(false, vec![ascii(0x010F, "Cam")], exif, vec![], None);
        let maker_pos = b.windows(64).position(|w| w == maker).unwrap();
        // IFD1 接在末尾，缩略图范围却指向 MakerNote 的后半段（不在末尾，截不掉）。
        let ifd1_off = b.len();
        let ifd1 = [
            long(false, TAG_THUMB_OFFSET, (maker_pos + 32) as u32),
            long(false, TAG_THUMB_LENGTH, 16),
        ];
        let mut none = Vec::new();
        put_ifd(false, &mut b, &ifd1, 0, &mut none, 0);
        let np = ifd0_next_pos(&b);
        b[np..np + 4].copy_from_slice(&(ifd1_off as u32).to_le_bytes());
        assert!(read(&b).fields().any(|f| f.ifd_num == exif::In::THUMBNAIL));

        assert!(normalize_exif(&b, 10, 10).is_none());
    }

    #[test]
    fn unreadable_ifd1_keeps_the_rest() {
        let mut b = sample();
        let np = ifd0_next_pos(&b);
        b[np..np + 4].copy_from_slice(&0xFFF0u32.to_le_bytes());

        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), b.len());
        assert_eq!(&out[np..np + 4], &[0, 0, 0, 0]);
        let x = read(&out);
        assert_eq!(uint(&x, exif::Tag::Orientation, exif::In::PRIMARY), Some(1));
        assert!(
            x.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)
                .is_some()
        );
    }

    #[test]
    fn missing_fields_ok() {
        let b = build(true, vec![ascii(0x010F, "Cam")], vec![], vec![], None);
        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out, b);
    }

    #[test]
    fn malformed_is_none() {
        assert!(normalize_exif(&[], 1, 1).is_none());
        assert!(normalize_exif(b"II*", 1, 1).is_none());
        assert!(normalize_exif(b"XX*\0\x08\0\0\0\0\0\0\0\0\0", 1, 1).is_none());
        // IFD0 偏移越界。
        assert!(normalize_exif(b"II*\0\xFF\0\0\0\0\0\0\0", 1, 1).is_none());
        // 条目数使目录越界。
        assert!(normalize_exif(b"II*\0\x08\0\0\0\xFF\xFF\0\0\0\0\0\0", 1, 1).is_none());
        // 子目录指回 IFD0。
        let b = build(
            false,
            vec![long(false, TAG_EXIF_IFD, 8)],
            vec![],
            vec![],
            None,
        );
        assert!(normalize_exif(&b, 1, 1).is_none());
        // 下一个目录（IFD1）指回 IFD0：当作没有缩略图，链接清零，其余保留。
        let mut b = build(false, vec![ascii(0x010F, "Cam")], vec![], vec![], None);
        let np = 8 + ifd_size(1) - 4;
        b[np..np + 4].copy_from_slice(&8u32.to_le_bytes());
        let out = normalize_exif(&b, 1, 1).unwrap();
        assert_eq!(&out[np..np + 4], &[0, 0, 0, 0]);
        // 外置数据越界。
        let mut b = build(false, vec![ascii(0x010F, "Camera")], vec![], vec![], None);
        let vp = 8 + 2 + 8;
        b[vp..vp + 4].copy_from_slice(&0xFFFFu32.to_le_bytes());
        assert!(normalize_exif(&b, 1, 1).is_none());
        // 超过 1 MB。
        let mut big = b"II*\0\x08\0\0\0\0\0\0\0\0\0".to_vec();
        big.resize(MAX_EXIF + 1, 0);
        assert!(normalize_exif(&big, 1, 1).is_none());
    }

    /// 把 `base`（不含缩略图的整块）续上 IFD1 与缩略图，返回 (整块, IFD1 位置)；
    /// `thumb_first` 个杂字节排在 IFD1 前并算进缩略图范围。
    fn append_ifd1(base: &[u8], thumb_first: usize, jpeg: &[u8]) -> (Vec<u8>, usize) {
        let mut out = base.to_vec();
        let thumb_off = base.len();
        let ifd1_off = thumb_off + thumb_first;
        out.extend(vec![0xBB; thumb_first]);
        let real_thumb_off = if thumb_first > 0 {
            thumb_off
        } else {
            ifd1_off + ifd_size(2)
        };
        let tl = if thumb_first > 0 {
            thumb_first + ifd_size(2) + jpeg.len()
        } else {
            jpeg.len()
        };
        let ifd1 = [
            long(false, TAG_THUMB_OFFSET, real_thumb_off as u32),
            long(false, TAG_THUMB_LENGTH, tl as u32),
        ];
        let mut none = Vec::new();
        put_ifd(false, &mut out, &ifd1, 0, &mut none, 0);
        out.extend(jpeg);
        (out, ifd1_off)
    }

    /// IFD0 的 next 指针位置：IFD0 在 8，条目数由 build 决定。
    fn ifd0_next_pos(b: &[u8]) -> usize {
        let n = u16::from_le_bytes([b[8], b[9]]) as usize;
        8 + 2 + n * 12
    }

    #[test]
    fn data_after_thumbnail_blocks_truncation() {
        let jpeg = vec![0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9];
        let maker: Vec<u8> = (0..64u8).collect();
        let exif = vec![short(false, TAG_PIXEL_X, 100), undef(0x927C, maker.clone())];
        let base = build(false, vec![ascii(0x010F, "Cam")], exif, vec![], None);
        let (mut b, ifd1_off) = append_ifd1(&base, 0, &jpeg);
        let np = ifd0_next_pos(&b);
        b[np..np + 4].copy_from_slice(&(ifd1_off as u32).to_le_bytes());
        // MakerNote 搬到缩略图之后，并把条目指过去。
        let maker_pos = b.len();
        b.extend(&maker);
        let exif_off = 8 + ifd_size(2);
        let vp = exif_off + 2 + 12 + 8;
        b[vp..vp + 4].copy_from_slice(&(maker_pos as u32).to_le_bytes());
        assert!(read(&b).fields().any(|f| f.ifd_num == exif::In::THUMBNAIL));

        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), b.len());
        assert_eq!(&out[maker_pos..], &maker[..]);
        assert!(
            !read(&out)
                .fields()
                .any(|f| f.ifd_num == exif::In::THUMBNAIL)
        );
    }

    #[test]
    fn data_between_ifd1_and_thumbnail_blocks_truncation() {
        let jpeg = vec![0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9];
        let maker: Vec<u8> = (0..64u8).collect();
        let exif = vec![short(false, TAG_PIXEL_X, 100), undef(0x927C, maker.clone())];
        let base = build(false, vec![ascii(0x010F, "Cam")], exif, vec![], None);
        // IFD1 之后、缩略图之前塞进 MakerNote。
        let mut b = base.clone();
        let ifd1_off = b.len();
        let maker_pos = ifd1_off + ifd_size(2);
        let thumb_off = maker_pos + maker.len();
        let ifd1 = [
            long(false, TAG_THUMB_OFFSET, thumb_off as u32),
            long(false, TAG_THUMB_LENGTH, jpeg.len() as u32),
        ];
        let mut none = Vec::new();
        put_ifd(false, &mut b, &ifd1, 0, &mut none, 0);
        b.extend(&maker);
        b.extend(&jpeg);
        let np = ifd0_next_pos(&b);
        b[np..np + 4].copy_from_slice(&(ifd1_off as u32).to_le_bytes());
        let vp = 8 + ifd_size(2) + 2 + 12 + 8;
        b[vp..vp + 4].copy_from_slice(&(maker_pos as u32).to_le_bytes());

        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), b.len());
        assert_eq!(&out[maker_pos..maker_pos + 64], &maker[..]);
        assert!(
            !read(&out)
                .fields()
                .any(|f| f.ifd_num == exif::In::THUMBNAIL)
        );
    }

    #[test]
    fn truncates_at_thumbnail_start_when_it_precedes_ifd1() {
        let jpeg = vec![0xFF, 0xD8, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9];
        let base = build(false, vec![ascii(0x010F, "Cam")], vec![], vec![], None);
        // 缩略图范围从 IFD1 之前开始，一直到整块末尾（把 IFD1 包在里面）。
        let (mut b, ifd1_off) = append_ifd1(&base, 8, &jpeg);
        let np = ifd0_next_pos(&b);
        b[np..np + 4].copy_from_slice(&(ifd1_off as u32).to_le_bytes());
        assert!(read(&b).fields().any(|f| f.ifd_num == exif::In::THUMBNAIL));

        let out = normalize_exif(&b, 10, 10).unwrap();
        assert_eq!(out.len(), base.len());
        assert!(
            !read(&out)
                .fields()
                .any(|f| f.ifd_num == exif::In::THUMBNAIL)
        );
        assert!(
            read(&out)
                .get_field(exif::Tag::Make, exif::In::PRIMARY)
                .is_some()
        );
    }

    #[test]
    fn directory_offset_inside_header_is_none() {
        // 够长的块，使指向头部的目录读起来不会越界。
        let mut b = build(false, vec![ascii(0x010F, "Cam")], vec![], vec![], None);
        b.resize(200, 0);
        let mut ifd0 = b.clone();
        ifd0[4..8].copy_from_slice(&4u32.to_le_bytes());
        assert!(normalize_exif(&ifd0, 1, 1).is_none());
        // 子目录偏移小于 8 同样拒绝。
        let b = build(
            false,
            vec![ascii(0x010F, "Cam"), long(false, TAG_GPS_IFD, 6)],
            vec![],
            vec![],
            None,
        );
        let mut b = b;
        b.resize(200, 0);
        assert!(normalize_exif(&b, 1, 1).is_none());
    }
}
