use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use anyhow::Result;
use clap::{Parser, ValueEnum};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use rand::Rng;

const NOISE_SIDE: u32 = 4096;
const HUGE_SIDE: u32 = 8000;
const HUGE_LINE_STEP: u32 = 500;
const MANY_SIDE: u32 = 256;
const MANY_DIRS: [&str; 3] = ["蜀国", "魏国", "吴国 备选"];
const ORIENTED_W: u32 = 600;
const ORIENTED_H: u32 = 300;
const ORIENTATIONS: [u16; 4] = [1, 3, 6, 8];

#[derive(Clone, Copy, ValueEnum)]
pub enum Preset {
    Transport,
    Huge,
    Many,
    /// 同一张横图分别带 EXIF 方向 1、3、6、8 的四个 JPEG。
    Oriented,
}

#[derive(Parser)]
#[command(about = "生成 Glance 实验用的测试样张")]
struct Cli {
    preset: Preset,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = 300)]
    count: usize,
}

pub fn generate(preset: Preset, out: &Path, count: usize) -> Result<Vec<PathBuf>> {
    fs::create_dir_all(out)?;
    match preset {
        Preset::Transport => transport(out),
        Preset::Huge => huge(out),
        Preset::Many => many(out, count),
        Preset::Oriented => oriented(out),
    }
}

fn write_png(path: &Path, rgb: &[u8], side: u32, compression: CompressionType) -> Result<()> {
    let writer = BufWriter::new(File::create(path)?);
    PngEncoder::new_with_quality(writer, compression, FilterType::NoFilter).write_image(
        rgb,
        side,
        side,
        ExtendedColorType::Rgb8,
    )?;
    Ok(())
}

fn transport(out: &Path) -> Result<Vec<PathBuf>> {
    let mut rgb = vec![0u8; (NOISE_SIDE * NOISE_SIDE * 3) as usize];
    rand::rng().fill_bytes(&mut rgb);
    let path = out.join("transport-50mb.png");
    write_png(&path, &rgb, NOISE_SIDE, CompressionType::Fast)?;
    Ok(vec![path])
}

fn huge(out: &Path) -> Result<Vec<PathBuf>> {
    let side = HUGE_SIDE as usize;
    let mut rgb = vec![0u8; side * side * 3];
    for (i, px) in rgb.chunks_exact_mut(3).enumerate() {
        let (x, y) = ((i % side) as u32, (i / side) as u32);
        if x % HUGE_LINE_STEP == 0 || y % HUGE_LINE_STEP == 0 {
            continue;
        }
        let v = (x * 255 / (HUGE_SIDE - 1)) as u8;
        px.copy_from_slice(&[v, v, v]);
    }
    let png = out.join("huge-8000.png");
    write_png(&png, &rgb, HUGE_SIDE, CompressionType::Default)?;
    let jpg = out.join("huge-8000.jpg");
    JpegEncoder::new_with_quality(BufWriter::new(File::create(&jpg)?), 90).write_image(
        &rgb,
        HUGE_SIDE,
        HUGE_SIDE,
        ExtendedColorType::Rgb8,
    )?;
    Ok(vec![png, jpg])
}

fn many(out: &Path, count: usize) -> Result<Vec<PathBuf>> {
    for dir in MANY_DIRS {
        fs::create_dir_all(out.join(dir))?;
    }
    let mut files = Vec::with_capacity(count);
    for n in 1..=count {
        let color = [
            (n * 37 % 256) as u8,
            (n * 91 % 256) as u8,
            (n * 53 % 256) as u8,
        ];
        let rgb = color.repeat((MANY_SIDE * MANY_SIDE) as usize);
        let path = out.join(MANY_DIRS[n % MANY_DIRS.len()]).join(format!("图 {n}.png"));
        write_png(&path, &rgb, MANY_SIDE, CompressionType::Default)?;
        files.push(path);
    }
    Ok(files)
}

/// 只含方向一项的大端 TIFF（EXIF 的主体，JPEG 编码器会补上 "Exif\0\0" 前缀）。
fn orientation_exif(orientation: u16) -> Vec<u8> {
    let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
    tiff.extend(1u16.to_be_bytes());
    tiff.extend(0x0112u16.to_be_bytes());
    tiff.extend(3u16.to_be_bytes());
    tiff.extend(1u32.to_be_bytes());
    tiff.extend(orientation.to_be_bytes());
    tiff.extend([0, 0]);
    tiff.extend(0u32.to_be_bytes());
    tiff
}

/// 一眼能看出朝向的横图：浅灰底，顶部一条红带，左上角一个深色方块。
fn oriented(out: &Path) -> Result<Vec<PathBuf>> {
    let (w, h) = (ORIENTED_W, ORIENTED_H);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let px = if x < h / 3 && y < h / 3 {
                [30, 30, 30]
            } else if y < h / 6 {
                [220, 40, 40]
            } else {
                [200, 200, 200]
            };
            rgb.extend(px);
        }
    }
    let mut files = Vec::with_capacity(ORIENTATIONS.len());
    for o in ORIENTATIONS {
        let path = out.join(format!("方向 {o}.jpg"));
        let mut encoder = JpegEncoder::new_with_quality(BufWriter::new(File::create(&path)?), 90);
        encoder.set_exif_metadata(orientation_exif(o))?;
        encoder.write_image(&rgb, w, h, ExtendedColorType::Rgb8)?;
        files.push(path);
    }
    Ok(files)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    for file in generate(cli.preset, &cli.out, cli.count)? {
        println!("{}", file.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_preset_is_about_50mb() {
        let dir = tempfile::tempdir().unwrap();
        let files = generate(Preset::Transport, dir.path(), 0).unwrap();
        let len = std::fs::metadata(&files[0]).unwrap().len();
        assert!((45_000_000..60_000_000).contains(&len), "实际 {len}");
        assert_eq!(image::image_dimensions(&files[0]).unwrap(), (4096, 4096));
    }

    #[test]
    fn huge_preset_is_8000_square() {
        let dir = tempfile::tempdir().unwrap();
        let files = generate(Preset::Huge, dir.path(), 0).unwrap();
        assert_eq!(files.len(), 2);
        for f in &files {
            assert_eq!(image::image_dimensions(f).unwrap(), (8000, 8000));
        }
    }

    #[test]
    fn oriented_preset_has_four_orientations_of_one_landscape_image() {
        let dir = tempfile::tempdir().unwrap();
        let files = generate(Preset::Oriented, dir.path(), 0).unwrap();
        let mut seen = vec![];
        for f in &files {
            let mut decoder = image::ImageReader::open(f).unwrap().into_decoder().unwrap();
            use image::ImageDecoder;
            assert_eq!(decoder.dimensions(), (ORIENTED_W, ORIENTED_H));
            seen.push(decoder.orientation().unwrap());
        }
        use image::metadata::Orientation::*;
        assert_eq!(seen, vec![NoTransforms, Rotate180, Rotate90, Rotate270]);
    }

    #[test]
    fn many_preset_spreads_over_three_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let files = generate(Preset::Many, dir.path(), 9).unwrap();
        assert_eq!(files.len(), 9);
        for sub in ["蜀国", "魏国", "吴国 备选"] {
            assert_eq!(std::fs::read_dir(dir.path().join(sub)).unwrap().count(), 3);
        }
    }
}
