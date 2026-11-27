//! HEIC / HEIF / AVIF 的文件头解析（ISOBMFF）：只读顶层的 `ftyp` 与 `meta`，不解码像素。

use std::io::{Read, Seek, SeekFrom};

/// `meta` 盒子超过这个大小视为读不出。
const MAX_META: u64 = 4 << 20;
/// `ftyp` 盒子的上限（品牌列表很短）。
const MAX_FTYP: u64 = 4096;
/// 顶层最多走这么多个盒子，防止构造出的超长小盒子链。
const MAX_TOP_BOXES: usize = 4096;

const ALPHA_URNS: [&str; 2] = [
    "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha",
    "urn:mpeg:hevc:2015:auxid:1",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeifKind {
    Heic,
    Avif,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeifInfo {
    pub kind: HeifKind,
    /// 主图的 ispe，未旋转。
    pub width: u32,
    pub height: u32,
    /// irot：逆时针转几个 90°，0..=3。
    pub turns_ccw: u8,
    pub bit_depth: Option<u8>,
    pub has_alpha: bool,
    pub animated: bool,
    /// Exif 条目里 TIFF 的文件偏移与长度（已跳过 4 字节的头偏移字段及其指示的字节）。
    pub exif: Option<(u64, u64)>,
}

impl HeifInfo {
    /// 按 irot 转正后的宽高（不看 EXIF 方向）。
    pub fn display_dims(&self) -> (u32, u32) {
        if self.turns_ccw % 2 == 1 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

type Fourcc = [u8; 4];

/// 顺序读字节；任何一步不够长都返回 None。
struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn new(b: &'a [u8]) -> Self {
        Cur { b, p: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.p.checked_add(n)?;
        let s = self.b.get(self.p..end)?;
        self.p = end;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_be_bytes(self.take(8)?.try_into().ok()?))
    }
    /// 0 到 8 字节的大端整数，0 字节为 0。
    fn uint(&mut self, n: u8) -> Option<u64> {
        if n > 8 {
            return None;
        }
        Some(
            self.take(n as usize)?
                .iter()
                .fold(0u64, |a, &x| (a << 8) | u64::from(x)),
        )
    }
    fn fourcc(&mut self) -> Option<Fourcc> {
        self.take(4)?.try_into().ok()
    }
    fn rest(&mut self) -> &'a [u8] {
        let s = &self.b[self.p..];
        self.p = self.b.len();
        s
    }
    fn done(&self) -> bool {
        self.p >= self.b.len()
    }
}

/// 把一段内容切成并列的盒子（类型，内容）。长度小于盒头或超出内容即为损坏。
fn children(b: &[u8]) -> Option<Vec<(Fourcc, &[u8])>> {
    let mut c = Cur::new(b);
    let mut out = vec![];
    while !c.done() {
        let size = u64::from(c.u32()?);
        let kind = c.fourcc()?;
        let body_len = match size {
            0 => c.b.len() - c.p,
            1 => usize::try_from(c.u64()?.checked_sub(16)?).ok()?,
            s if s < 8 => return None,
            s => (s - 8) as usize,
        };
        out.push((kind, c.take(body_len)?));
    }
    Some(out)
}

/// 带版本与标志的盒子内容：（版本，标志，其后的内容）。
fn full_body(b: &[u8]) -> Option<(u8, u32, &[u8])> {
    let mut c = Cur::new(b);
    let v = c.u32()?;
    Some(((v >> 24) as u8, v & 0xFF_FFFF, c.rest()))
}

struct Brands {
    kind: HeifKind,
    animated: bool,
}

/// 从 `ftyp` 的内容（主品牌、副版本、兼容品牌）判断种类。
fn brands(body: &[u8]) -> Option<Brands> {
    let major: Fourcc = body.get(..4)?.try_into().ok()?;
    let compat: Vec<Fourcc> = body
        .get(8..)?
        .chunks_exact(4)
        .map(|c| c.try_into().unwrap_or([0; 4]))
        .collect();
    let has = |names: &[&[u8; 4]]| {
        std::iter::once(&major)
            .chain(compat.iter())
            .any(|b| names.contains(&b))
    };
    let kind = if has(&[b"avif", b"avis"]) {
        HeifKind::Avif
    } else if has(&[
        b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1",
    ]) {
        HeifKind::Heic
    } else {
        return None;
    };
    let animated = [b"avis", b"msf1", b"hevc", b"hevx"].contains(&&major);
    Some(Brands { kind, animated })
}

/// 只看 ftyp：不是 ISOBMFF 或品牌不认识返回 None。
pub fn sniff(head: &[u8]) -> Option<HeifKind> {
    if head.get(4..8)? != b"ftyp" {
        return None;
    }
    let size = u32::from_be_bytes(head[..4].try_into().ok()?) as usize;
    let (start, end) = match size {
        0 => (8, head.len()),
        1 => (16, head.len()),
        s => (8, s.min(head.len())),
    };
    brands(head.get(start..end)?).map(|b| b.kind)
}

/// 读到的主图与条目信息：来自 `meta` 盒子。
struct MetaInfo {
    width: u32,
    height: u32,
    turns_ccw: u8,
    bit_depth: Option<u8>,
    has_alpha: bool,
    /// Exif 条目在文件里的（偏移，长度），含开头 4 字节的头偏移字段。
    exif_extent: Option<(u64, u64)>,
}

fn analyze_meta(meta_body: &[u8]) -> Option<MetaInfo> {
    let (_, _, rest) = full_body(meta_body)?;
    let kids = children(rest)?;
    let find = |k: &[u8; 4]| kids.iter().find(|(t, _)| t == k).map(|(_, b)| *b);

    let (v, _, p) = full_body(find(b"pitm")?)?;
    let mut c = Cur::new(p);
    let primary = if v == 0 {
        u32::from(c.u16()?)
    } else {
        c.u32()?
    };

    let iprp = children(find(b"iprp")?)?;
    let props = children(iprp.iter().find(|(t, _)| t == b"ipco")?.1)?;
    let mut assoc: Vec<(u32, usize)> = vec![];
    for (_, b) in iprp.iter().filter(|(t, _)| t == b"ipma") {
        let (v, flags, p) = full_body(b)?;
        let mut c = Cur::new(p);
        let entries = c.u32()?;
        'entries: for _ in 0..entries {
            let (Some(item), Some(n)) = (
                if v < 1 {
                    c.u16().map(u32::from)
                } else {
                    c.u32()
                },
                c.u8(),
            ) else {
                break;
            };
            for _ in 0..n {
                let idx = if flags & 1 == 1 {
                    c.u16().map(|x| usize::from(x & 0x7FFF))
                } else {
                    c.u8().map(|x| usize::from(x & 0x7F))
                };
                let Some(idx) = idx else { break 'entries };
                assoc.push((item, idx));
            }
        }
    }

    let (mut dims, mut turns, mut depth, mut alpha) = (None, 0u8, None::<u8>, false);
    for &(item, idx) in &assoc {
        let Some((kind, body)) = idx.checked_sub(1).and_then(|i| props.get(i)) else {
            continue;
        };
        match kind {
            b"auxC" => {
                if let Some((_, _, p)) = full_body(body) {
                    let urn = p.split(|&b| b == 0).next().unwrap_or(&[]);
                    alpha |= ALPHA_URNS.iter().any(|u| u.as_bytes() == urn);
                }
            }
            _ if item != primary => {}
            b"ispe" if dims.is_none() => {
                if let Some((_, _, p)) = full_body(body) {
                    let mut c = Cur::new(p);
                    if let (Some(w), Some(h)) = (c.u32(), c.u32()) {
                        dims = Some((w, h));
                    }
                }
            }
            b"irot" => turns = body.first().map_or(0, |b| b & 3),
            b"pixi" => {
                if let Some((_, _, p)) = full_body(body) {
                    let mut c = Cur::new(p);
                    if let Some(n) = c.u8() {
                        depth = c.take(n as usize).and_then(|d| d.iter().copied().max());
                    }
                }
            }
            _ => {}
        }
    }
    let (width, height) = dims?;

    let exif_extent =
        exif_item(find(b"iinf")).and_then(|id| find(b"iloc").and_then(|l| locate(l, id)));
    Some(MetaInfo {
        width,
        height,
        turns_ccw: turns,
        bit_depth: depth,
        has_alpha: alpha,
        exif_extent,
    })
}

/// `iinf` 里类型为 `Exif` 的条目的编号。
fn exif_item(iinf: Option<&[u8]>) -> Option<u32> {
    let (v, _, p) = full_body(iinf?)?;
    let mut c = Cur::new(p);
    if v == 0 {
        c.u16()?;
    } else {
        c.u32()?;
    }
    for (kind, body) in children(c.rest())? {
        if &kind != b"infe" {
            continue;
        }
        let (v, _, p) = full_body(body)?;
        if v < 2 {
            continue;
        }
        let mut c = Cur::new(p);
        let id = if v == 2 {
            u32::from(c.u16()?)
        } else {
            c.u32()?
        };
        c.u16()?;
        if &c.fourcc()? == b"Exif" {
            return Some(id);
        }
    }
    None
}

/// `iloc` 里某个条目的（偏移，长度）：只认版本 0 到 2、构造方式 0、单区段。
fn locate(iloc: &[u8], want: u32) -> Option<(u64, u64)> {
    let (v, _, p) = full_body(iloc)?;
    if v > 2 {
        return None;
    }
    let mut c = Cur::new(p);
    let (sizes, more) = (c.u8()?, c.u8()?);
    let (off_size, len_size, base_size) = (sizes >> 4, sizes & 15, more >> 4);
    let index_size = if v == 0 { 0 } else { more & 15 };
    let count = if v < 2 { u32::from(c.u16()?) } else { c.u32()? };
    for _ in 0..count {
        let id = if v < 2 { u32::from(c.u16()?) } else { c.u32()? };
        let method = if v == 0 { 0 } else { c.u16()? & 15 };
        let dref = c.u16()?;
        let base = c.uint(base_size)?;
        let extents = c.u16()?;
        let mut first = None;
        for i in 0..extents {
            c.uint(index_size)?;
            let off = c.uint(off_size)?;
            let len = c.uint(len_size)?;
            if i == 0 {
                first = Some((base.checked_add(off)?, len));
            }
        }
        if id == want {
            return if method == 0 && dref == 0 && extents == 1 {
                first
            } else {
                None
            };
        }
    }
    None
}

/// 解析 HEIC / HEIF / AVIF 的文件头。不是这类文件或读不出主图尺寸返回 None。
pub fn parse<R: Read + Seek>(r: &mut R) -> Option<HeifInfo> {
    let file_len = r.seek(SeekFrom::End(0)).ok()?;
    let (mut brands_found, mut meta_body) = (None, None);
    let mut pos = 0u64;
    for n in 0..MAX_TOP_BOXES {
        if pos.checked_add(8)? > file_len {
            break;
        }
        r.seek(SeekFrom::Start(pos)).ok()?;
        let mut h = [0u8; 8];
        r.read_exact(&mut h).ok()?;
        let size = u64::from(u32::from_be_bytes(h[..4].try_into().ok()?));
        let kind: Fourcc = h[4..].try_into().ok()?;
        let (hdr, total) = match size {
            0 => (8, file_len - pos),
            1 => {
                let mut big = [0u8; 8];
                r.read_exact(&mut big).ok()?;
                (16, u64::from_be_bytes(big))
            }
            s => (8, s),
        };
        if total < hdr {
            return None;
        }
        if n == 0 && &kind != b"ftyp" {
            return None;
        }
        let wanted = &kind == b"ftyp" || &kind == b"meta";
        if total > file_len - pos {
            if wanted {
                return None;
            }
            break;
        }
        if wanted {
            let body_len = total - hdr;
            let cap = if &kind == b"ftyp" { MAX_FTYP } else { MAX_META };
            if body_len > cap {
                return None;
            }
            let mut body = vec![0u8; body_len as usize];
            r.seek(SeekFrom::Start(pos + hdr)).ok()?;
            r.read_exact(&mut body).ok()?;
            if &kind == b"ftyp" {
                brands_found = Some(brands(&body)?);
            } else {
                meta_body = Some(body);
            }
            if brands_found.is_some() && meta_body.is_some() {
                break;
            }
        }
        pos += total;
    }
    let (b, meta) = (brands_found?, meta_body?);
    let m = analyze_meta(&meta)?;
    let exif = m.exif_extent.and_then(|(off, len)| {
        // 前 4 字节是“头偏移”字段：其后再跳过这么多字节才是 TIFF
        if len < 4 || off.checked_add(len)? > file_len {
            return None;
        }
        r.seek(SeekFrom::Start(off)).ok()?;
        let mut f = [0u8; 4];
        r.read_exact(&mut f).ok()?;
        let skip = u64::from(u32::from_be_bytes(f)).checked_add(4)?;
        (skip < len).then(|| (off + skip, len - skip))
    });
    Some(HeifInfo {
        kind: b.kind,
        width: m.width,
        height: m.height,
        turns_ccw: m.turns_ccw,
        bit_depth: m.bit_depth,
        has_alpha: m.has_alpha,
        animated: b.animated,
        exif,
    })
}

#[cfg(any(test, feature = "testkit"))]
pub mod testkit {
    //! 测试用的 HEIF 样本构造：`bx` 拼盒子，`sample` 按选项拼出一个完整文件。
    //! 其他 crate 的测试通过特性 `testkit` 使用。

    /// 普通盒子：长度 + 类型 + 内容。
    pub fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }

    /// 带版本与标志的盒子。
    pub fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version];
        b.extend_from_slice(&flags.to_be_bytes()[1..]);
        b.extend_from_slice(body);
        bx(kind, &b)
    }

    /// `ftyp` 盒子。
    pub fn ftyp(major: &[u8; 4], compat: &[[u8; 4]]) -> Vec<u8> {
        let mut b = major.to_vec();
        b.extend_from_slice(&[0; 4]);
        for c in compat {
            b.extend_from_slice(c);
        }
        bx(b"ftyp", &b)
    }

    #[derive(Clone)]
    pub struct ExifSpec {
        /// `iloc` 版本，0 到 2。
        pub iloc_version: u8,
        /// 条目开头 4 字节“头偏移”字段的值；非 0 时在其后放这么多字节的 `Exif\0\0` 前缀。
        pub skip: u32,
        /// TIFF 结构（以 `II` 或 `MM` 开头）。
        pub tiff: Vec<u8>,
    }

    #[derive(Clone)]
    pub struct SampleOpts {
        pub major: [u8; 4],
        pub compat: Vec<[u8; 4]>,
        /// 主图的 `ispe`。
        pub size: (u32, u32),
        /// 非空时在主图前放一个带这组 `ispe` 的条目 1（主图变成条目 2），用来验证 `pitm`。
        pub decoy: Option<(u32, u32)>,
        pub irot: Option<u8>,
        /// `pixi` 各通道位深。
        pub pixi: Option<Vec<u8>>,
        /// 额外放一个辅助条目，关联一个带这个 URN 的 `auxC`。
        pub aux_urn: Option<&'static str>,
        pub exif: Option<ExifSpec>,
        /// 让主图额外关联一个这个下标的属性（可指向不存在的属性）。
        pub extra_assoc: Option<u8>,
    }

    impl Default for SampleOpts {
        fn default() -> Self {
            SampleOpts {
                major: *b"heic",
                compat: vec![*b"mif1"],
                size: (4000, 3000),
                decoy: None,
                irot: None,
                pixi: None,
                aux_urn: None,
                exif: None,
                extra_assoc: None,
            }
        }
    }

    const EXIF_ITEM: u32 = 4;

    fn exif_data(e: &ExifSpec) -> Vec<u8> {
        let mut d = e.skip.to_be_bytes().to_vec();
        d.extend_from_slice(&b"Exif\0\0"[..e.skip as usize]);
        d.extend_from_slice(&e.tiff);
        d
    }

    fn infe(id: u32, kind: &[u8; 4]) -> Vec<u8> {
        let mut b = (id as u16).to_be_bytes().to_vec();
        b.extend_from_slice(&[0, 0]);
        b.extend_from_slice(kind);
        b.push(0);
        full(b"infe", 2, 0, &b)
    }

    fn iloc(version: u8, offset: u32, len: u32) -> Vec<u8> {
        let mut b = vec![0x44, 0x00]; // 偏移 4 字节、长度 4 字节、无基准偏移、无索引
        if version < 2 {
            b.extend_from_slice(&1u16.to_be_bytes());
            b.extend_from_slice(&(EXIF_ITEM as u16).to_be_bytes());
        } else {
            b.extend_from_slice(&1u32.to_be_bytes());
            b.extend_from_slice(&EXIF_ITEM.to_be_bytes());
        }
        if version >= 1 {
            b.extend_from_slice(&[0, 0]); // 构造方式 0
        }
        b.extend_from_slice(&[0, 0]); // 数据引用
        b.extend_from_slice(&1u16.to_be_bytes()); // 一个区段
        b.extend_from_slice(&offset.to_be_bytes());
        b.extend_from_slice(&len.to_be_bytes());
        full(b"iloc", version, 0, &b)
    }

    fn meta(o: &SampleOpts, exif_offset: u32) -> Vec<u8> {
        let primary: u32 = if o.decoy.is_some() { 2 } else { 1 };
        let ispe = |(w, h): (u32, u32)| {
            let mut b = w.to_be_bytes().to_vec();
            b.extend_from_slice(&h.to_be_bytes());
            full(b"ispe", 0, 0, &b)
        };
        // ipco 的属性（下标从 1 起）与关联：(条目, 下标)
        let mut props: Vec<Vec<u8>> = vec![];
        let mut assoc: Vec<(u32, u8)> = vec![];
        let mut add = |p: Vec<u8>| {
            props.push(p);
            props.len() as u8
        };
        if let Some(d) = o.decoy {
            let i = add(ispe(d));
            assoc.push((1, i));
        }
        let i = add(ispe(o.size));
        assoc.push((primary, i));
        if let Some(t) = o.irot {
            let i = add(bx(b"irot", &[t]));
            assoc.push((primary, i | 0x80));
        }
        if let Some(depths) = &o.pixi {
            let mut b = vec![depths.len() as u8];
            b.extend_from_slice(depths);
            let i = add(full(b"pixi", 0, 0, &b));
            assoc.push((primary, i));
        }
        if let Some(urn) = o.aux_urn {
            let mut b = urn.as_bytes().to_vec();
            b.push(0);
            let i = add(full(b"auxC", 0, 0, &b));
            assoc.push((3, i));
        }
        if let Some(i) = o.extra_assoc {
            assoc.push((primary, i));
        }

        let mut ipma = (assoc.len() as u32).to_be_bytes().to_vec();
        for (item, idx) in &assoc {
            ipma.extend_from_slice(&(*item as u16).to_be_bytes());
            ipma.extend_from_slice(&[1, *idx]);
        }
        let ipco = bx(b"ipco", &props.concat());
        let iprp = bx(b"iprp", &[ipco, full(b"ipma", 0, 0, &ipma)].concat());

        let mut items = vec![];
        if o.decoy.is_some() {
            items.push(infe(1, b"hvc1"));
        }
        items.push(infe(primary, b"hvc1"));
        if o.aux_urn.is_some() {
            items.push(infe(3, b"hvc1"));
        }
        if o.exif.is_some() {
            items.push(infe(EXIF_ITEM, b"Exif"));
        }
        let mut iinf = (items.len() as u16).to_be_bytes().to_vec();
        iinf.extend(items.concat());

        let mut kids = vec![
            full(b"pitm", 0, 0, &(primary as u16).to_be_bytes()),
            full(b"iinf", 0, 0, &iinf),
        ];
        if let Some(e) = &o.exif {
            kids.push(iloc(e.iloc_version, exif_offset, exif_data(e).len() as u32));
        }
        kids.push(iprp);
        full(b"meta", 0, 0, &kids.concat())
    }

    /// 拼一个完整文件：`ftyp`、`meta`，有 EXIF 时再接一个装着 EXIF 数据的 `mdat`。
    pub fn sample(o: &SampleOpts) -> Vec<u8> {
        let head = ftyp(&o.major, &o.compat);
        // meta 的长度与偏移值无关：先用 0 量出长度，再填真正的偏移
        let m0 = meta(o, 0);
        let mdat_start = (head.len() + m0.len()) as u32;
        let m = meta(o, mdat_start + 8);
        let mut out = [head, m].concat();
        if let Some(e) = &o.exif {
            out.extend(bx(b"mdat", &exif_data(e)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use std::io::Cursor;
    use std::time::{Duration, Instant};

    fn parse_bytes(b: &[u8]) -> Option<HeifInfo> {
        parse(&mut Cursor::new(b))
    }

    fn tiff(le: bool) -> Vec<u8> {
        let mut t = if le {
            b"II*\0".to_vec()
        } else {
            b"MM\0*".to_vec()
        };
        t.extend_from_slice(&[0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
        t
    }

    #[test]
    fn sniff_brands() {
        assert_eq!(sniff(&ftyp(b"heic", &[])), Some(HeifKind::Heic));
        assert_eq!(
            sniff(&ftyp(b"mif1", &[*b"miaf", *b"avif"])),
            Some(HeifKind::Avif)
        );
        assert_eq!(sniff(&ftyp(b"avis", &[])), Some(HeifKind::Avif));
        assert_eq!(sniff(&ftyp(b"mif1", &[*b"heic"])), Some(HeifKind::Heic));
        assert_eq!(sniff(&ftyp(b"isom", &[*b"mp42"])), None);
        assert_eq!(
            sniff(&[
                0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1
            ]),
            None
        );
        assert_eq!(sniff(&[]), None);
    }

    #[test]
    fn primary_item_dims_and_rotation() {
        let o = SampleOpts {
            size: (4000, 3000),
            decoy: Some((64, 48)),
            irot: Some(1),
            ..Default::default()
        };
        let info = parse_bytes(&sample(&o)).unwrap();
        assert_eq!((info.width, info.height), (4000, 3000));
        assert_eq!(info.turns_ccw, 1);
        assert_eq!(info.display_dims(), (3000, 4000));
        assert_eq!(info.kind, HeifKind::Heic);

        let o = SampleOpts {
            irot: Some(2),
            ..Default::default()
        };
        assert_eq!(
            parse_bytes(&sample(&o)).unwrap().display_dims(),
            (4000, 3000)
        );
        let o = SampleOpts {
            irot: None,
            ..Default::default()
        };
        assert_eq!(parse_bytes(&sample(&o)).unwrap().turns_ccw, 0);
    }

    #[test]
    fn bit_depth_alpha_animated() {
        let plain = parse_bytes(&sample(&SampleOpts::default())).unwrap();
        assert_eq!(plain.bit_depth, None);
        assert!(!plain.has_alpha);
        assert!(!plain.animated);

        let o = SampleOpts {
            pixi: Some(vec![10, 10, 10]),
            ..Default::default()
        };
        assert_eq!(parse_bytes(&sample(&o)).unwrap().bit_depth, Some(10));
        let o = SampleOpts {
            pixi: Some(vec![8, 10, 8]),
            ..Default::default()
        };
        assert_eq!(parse_bytes(&sample(&o)).unwrap().bit_depth, Some(10));

        for urn in [
            "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha",
            "urn:mpeg:hevc:2015:auxid:1",
        ] {
            let o = SampleOpts {
                aux_urn: Some(urn),
                ..Default::default()
            };
            assert!(parse_bytes(&sample(&o)).unwrap().has_alpha, "{urn}");
        }
        let o = SampleOpts {
            aux_urn: Some("urn:mpeg:hevc:2015:auxid:2"),
            ..Default::default()
        };
        assert!(!parse_bytes(&sample(&o)).unwrap().has_alpha);

        for (major, anim) in [
            (*b"avis", true),
            (*b"msf1", true),
            (*b"hevc", true),
            (*b"hevx", true),
            (*b"avif", false),
            (*b"heic", false),
        ] {
            let o = SampleOpts {
                major,
                compat: vec![*b"avis"],
                ..Default::default()
            };
            assert_eq!(
                parse_bytes(&sample(&o)).unwrap().animated,
                anim,
                "{major:?}"
            );
        }
        let o = SampleOpts {
            major: *b"avis",
            compat: vec![],
            ..Default::default()
        };
        assert_eq!(parse_bytes(&sample(&o)).unwrap().kind, HeifKind::Avif);
    }

    #[test]
    fn exif_location() {
        for version in 0..=2u8 {
            for skip in [0u32, 6] {
                for le in [true, false] {
                    let t = tiff(le);
                    let o = SampleOpts {
                        exif: Some(ExifSpec {
                            iloc_version: version,
                            skip,
                            tiff: t.clone(),
                        }),
                        ..Default::default()
                    };
                    let bytes = sample(&o);
                    let (off, len) = parse_bytes(&bytes)
                        .unwrap()
                        .exif
                        .unwrap_or_else(|| panic!("v{version} skip{skip}"));
                    let got = &bytes[off as usize..(off + len) as usize];
                    assert_eq!(got, &t[..], "v{version} skip{skip} le{le}");
                }
            }
        }
        assert_eq!(
            parse_bytes(&sample(&SampleOpts::default())).unwrap().exif,
            None
        );
    }

    /// 把样本拆成 ftyp、meta、其余三段。
    fn split(b: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let n1 = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
        let n2 = u32::from_be_bytes(b[n1..n1 + 4].try_into().unwrap()) as usize;
        (
            b[..n1].to_vec(),
            b[n1..n1 + n2].to_vec(),
            b[n1 + n2..].to_vec(),
        )
    }

    #[test]
    fn box_size_0_and_1() {
        let o = SampleOpts {
            irot: Some(1),
            pixi: Some(vec![8]),
            ..Default::default()
        };
        let (f, m, _) = split(&sample(&o));
        let mdat = bx(b"mdat", &[0u8; 16]);

        // 长度 0：meta 是最后一个盒子，延伸到文件尾
        let mut m0 = m.clone();
        m0[..4].copy_from_slice(&0u32.to_be_bytes());
        let b = [f.clone(), mdat.clone(), m0].concat();
        let info = parse_bytes(&b).unwrap();
        assert_eq!(
            (info.width, info.height, info.turns_ccw, info.bit_depth),
            (4000, 3000, 1, Some(8))
        );

        // 长度 1：后跟 8 字节的 64 位长度
        let mut m1 = 1u32.to_be_bytes().to_vec();
        m1.extend_from_slice(b"meta");
        m1.extend_from_slice(&(m.len() as u64 + 8).to_be_bytes());
        m1.extend_from_slice(&m[8..]);
        let b = [f.clone(), m1, mdat.clone()].concat();
        assert_eq!(parse_bytes(&b).unwrap().width, 4000);

        // ftyp 也可以用 64 位长度
        let mut f1 = 1u32.to_be_bytes().to_vec();
        f1.extend_from_slice(b"ftyp");
        f1.extend_from_slice(&(f.len() as u64 + 8).to_be_bytes());
        f1.extend_from_slice(&f[8..]);
        let b = [f1, m, mdat].concat();
        assert_eq!(parse_bytes(&b).unwrap().kind, HeifKind::Heic);
    }

    #[test]
    fn truncated_and_malformed_never_panic() {
        // 防跑飞与巨量分配：整轮扫描总用时放宽到 5 秒，不对单次计时（负载高的 CI 上会抖）
        let started = Instant::now();

        let full_sample = sample(&SampleOpts {
            irot: Some(3),
            pixi: Some(vec![10, 10, 10]),
            aux_urn: Some("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"),
            decoy: Some((10, 10)),
            exif: Some(ExifSpec {
                iloc_version: 1,
                skip: 6,
                tiff: tiff(true),
            }),
            ..Default::default()
        });
        assert!(parse_bytes(&full_sample).is_some());
        for n in 0..full_sample.len() {
            if let Some(info) = parse_bytes(&full_sample[..n])
                && let Some((off, len)) = info.exif
            {
                assert!(off + len <= n as u64, "截断到 {n} 字节后 EXIF 范围超出文件");
            }
        }

        // 缺 mdat：iloc 偏移超出文件，主图信息仍在，EXIF 为 None
        let (f, m, _) = split(&full_sample);
        let info = parse_bytes(&[f.clone(), m.clone()].concat()).unwrap();
        assert_eq!(info.exif, None);
        assert_eq!(info.width, 4000);

        // ipma 引用不存在的属性下标：忽略这条关联
        let o = SampleOpts {
            extra_assoc: Some(99),
            ..Default::default()
        };
        let info = parse_bytes(&sample(&o));
        assert!(info.is_none_or(|i| i.width == 4000));

        // 盒子长度小于 8
        let mut bad = m.clone();
        bad[12..16].copy_from_slice(&4u32.to_be_bytes());
        assert_eq!(parse_bytes(&[f.clone(), bad].concat()), None);
        let mut bad_ftyp = f.clone();
        bad_ftyp[..4].copy_from_slice(&5u32.to_be_bytes());
        assert_eq!(parse_bytes(&[bad_ftyp, m.clone()].concat()), None);

        // 长度超出文件
        let mut big = m.clone();
        big[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(parse_bytes(&[f.clone(), big].concat()), None);
        let mut huge64 = f.clone();
        huge64.extend_from_slice(&1u32.to_be_bytes());
        huge64.extend_from_slice(b"meta");
        huge64.extend_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(parse_bytes(&huge64), None);
        // 声称 meta 有 3 GB 但文件很小：不得按声称的长度分配
        let mut claim = f.clone();
        claim.extend_from_slice(&0xC000_0000u32.to_be_bytes());
        claim.extend_from_slice(b"meta");
        assert_eq!(parse_bytes(&claim), None);

        // 计数字段极大而数据很短：读不出就停，不预分配
        let mut iinf = 0xFFFFu16.to_be_bytes().to_vec();
        iinf.extend_from_slice(&[0; 3]);
        let mut ipma = u32::MAX.to_be_bytes().to_vec();
        ipma.extend_from_slice(&[0; 3]);
        let kids = [
            full(b"pitm", 0, 0, &1u16.to_be_bytes()),
            full(b"iinf", 0, 0, &iinf),
            bx(
                b"iprp",
                &[bx(b"ipco", &[]), full(b"ipma", 0, 0, &ipma)].concat(),
            ),
        ]
        .concat();
        let evil = [f.clone(), full(b"meta", 0, 0, &kids)].concat();
        assert_eq!(parse_bytes(&evil), None);

        // 不是 HEIF
        assert_eq!(parse_bytes(b""), None);
        assert_eq!(
            parse_bytes(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]),
            None
        );
        assert_eq!(
            parse_bytes(&[f.clone(), bx(b"mdat", &[1, 2, 3])].concat()),
            None
        );

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "解析用时异常：{:?}",
            started.elapsed()
        );
    }
}
