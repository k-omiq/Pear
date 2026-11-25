//! Optional RT-DETR text/bubble proposals, with a validated ONNX tensor contract.
// Preprocessing and seam deduplication ported from Komatose ocr/detect.py, d9be51e.

use image::{DynamicImage, GenericImageView};
use ort::session::Session;
use ort::value::{Tensor, TensorElementType, ValueType};

use super::cvops::resize_linear_u8;
use super::tiles::band_spans;

const INPUT_SIZE: usize = 640;
const QUERIES: usize = 300;
const CONFIDENCE: f32 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Bubble,
    TextBubble,
    TextFree,
}

impl Class {
    pub fn kind(self) -> Option<&'static str> {
        match self {
            Self::Bubble => None,
            Self::TextBubble => Some("bubble"),
            Self::TextFree => Some("free"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub bbox: [f32; 4],
    pub score: f32,
    pub class: Class,
    truncated: bool,
    source: usize,
}

impl Region {
    pub fn new(bbox: [f32; 4], score: f32, class: Class) -> Self {
        Self {
            bbox,
            score,
            class,
            truncated: false,
            source: 0,
        }
    }

    fn place_band(&mut self, start: u32, end: u32, page_height: u32, source: usize) {
        self.truncated = (start > 0 && self.bbox[1] < 6.0)
            || (end < page_height && self.bbox[3] > (end - start) as f32 - 6.0);
        self.bbox[1] += start as f32;
        self.bbox[3] += start as f32;
        self.source = source;
    }
}

pub struct RtDetr {
    session: Session,
}

fn check_names(actual: &[&str], expected: &[&str]) -> Result<(), String> {
    if actual.len() != expected.len() || expected.iter().any(|name| !actual.contains(name)) {
        return Err(format!(
            "RT-DETR tensor names: expected {expected:?}, got {actual:?}"
        ));
    }
    Ok(())
}

fn check_tensor(
    name: &str,
    ty: TensorElementType,
    shape: &[i64],
    expected_ty: TensorElementType,
    expected_shape: &[i64],
) -> Result<(), String> {
    if ty != expected_ty
        || shape.len() != expected_shape.len()
        || shape
            .iter()
            .zip(expected_shape)
            .any(|(&a, &b)| a != -1 && a != b)
    {
        return Err(format!(
            "RT-DETR {name}: expected {expected_ty:?} {expected_shape:?}, got {ty:?} {shape:?}"
        ));
    }
    Ok(())
}

fn validate_session(session: &Session) -> Result<(), String> {
    check_names(
        &session
            .inputs()
            .iter()
            .map(|x| x.name())
            .collect::<Vec<_>>(),
        &["images", "orig_target_sizes"],
    )?;
    check_names(
        &session
            .outputs()
            .iter()
            .map(|x| x.name())
            .collect::<Vec<_>>(),
        &["labels", "boxes", "scores"],
    )?;
    for (name, ty, shape) in [
        ("images", TensorElementType::Float32, &[1, 3, 640, 640][..]),
        ("orig_target_sizes", TensorElementType::Int64, &[1, 2][..]),
        ("labels", TensorElementType::Int64, &[1, 300][..]),
        ("boxes", TensorElementType::Float32, &[1, 300, 4][..]),
        ("scores", TensorElementType::Float32, &[1, 300][..]),
    ] {
        let outlet = session
            .inputs()
            .iter()
            .chain(session.outputs())
            .find(|x| x.name() == name)
            .unwrap();
        match outlet.dtype() {
            ValueType::Tensor {
                ty: actual_ty,
                shape: actual_shape,
                ..
            } => check_tensor(name, *actual_ty, actual_shape, ty, shape)?,
            other => return Err(format!("RT-DETR {name}: expected a tensor, got {other:?}")),
        }
    }
    Ok(())
}

impl RtDetr {
    /// CPU only, like the panel model: on CoreML the session loads and every
    /// run then fails ("Unable to compute the prediction", seen 2026-11-03),
    /// so the detector was skipped on every Mac without a word.
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let session = Session::builder()
            .and_then(|mut b| b.commit_from_file(path))
            .map_err(|e| format!("RT-DETR load failed: {e}"))?;
        validate_session(&session)?;
        Ok(Self { session })
    }

    fn detect(&mut self, image: &DynamicImage) -> Result<Vec<Region>, String> {
        let (width, height) = image.dimensions();
        let images = Tensor::from_array(([1usize, 3, INPUT_SIZE, INPUT_SIZE], preprocess(image)?))
            .map_err(|e| format!("RT-DETR images input: {e}"))?;
        // The export expects width first, despite the common height/width convention.
        let sizes = Tensor::from_array(([1usize, 2], vec![i64::from(width), i64::from(height)]))
            .map_err(|e| format!("RT-DETR orig_target_sizes input: {e}"))?;
        let outputs = self
            .session
            .run(ort::inputs!["images" => images, "orig_target_sizes" => sizes])
            .map_err(|e| format!("RT-DETR inference failed: {e}"))?;
        let (label_shape, labels) = outputs
            .get("labels")
            .ok_or("RT-DETR missing labels output")?
            .try_extract_tensor::<i64>()
            .map_err(|e| format!("RT-DETR labels: {e}"))?;
        let (box_shape, boxes) = outputs
            .get("boxes")
            .ok_or("RT-DETR missing boxes output")?
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("RT-DETR boxes: {e}"))?;
        let (score_shape, scores) = outputs
            .get("scores")
            .ok_or("RT-DETR missing scores output")?
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("RT-DETR scores: {e}"))?;
        decode(
            label_shape,
            labels,
            box_shape,
            boxes,
            score_shape,
            scores,
            width,
            height,
        )
    }

    pub fn detect_page(&mut self, image: &DynamicImage) -> Result<Vec<Region>, String> {
        let (width, height) = image.dimensions();
        let mut regions = self.detect(image)?;
        // Keep the full-page context pass, then add the same bands as CTD.
        for (source, (start, end)) in band_spans(width, height).into_iter().enumerate() {
            let band = image.crop_imm(0, start, width, end - start);
            for mut region in self.detect(&band)? {
                region.place_band(start, end, height, source + 1);
                regions.push(region);
            }
        }
        Ok(dedupe(regions))
    }
}

fn preprocess(image: &DynamicImage) -> Result<Vec<f32>, String> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return Err("RT-DETR cannot detect an empty image".into());
    }
    let rgb = image.to_rgb8();
    let resized = resize_linear_u8(
        rgb.as_raw(),
        w as usize,
        h as usize,
        3,
        INPUT_SIZE,
        INPUT_SIZE,
    );
    let plane = INPUT_SIZE * INPUT_SIZE;
    let mut out = vec![0.0; 3 * plane];
    for (i, rgb) in resized.as_chunks::<3>().0.iter().enumerate() {
        for c in 0..3 {
            out[c * plane + i] = f32::from(rgb[c]) / 255.0;
        }
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn decode(
    label_shape: &[i64],
    labels: &[i64],
    box_shape: &[i64],
    boxes: &[f32],
    score_shape: &[i64],
    scores: &[f32],
    width: u32,
    height: u32,
) -> Result<Vec<Region>, String> {
    for (name, actual, expected, len, count) in [
        ("labels", label_shape, &[1, 300][..], labels.len(), QUERIES),
        (
            "boxes",
            box_shape,
            &[1, 300, 4][..],
            boxes.len(),
            QUERIES * 4,
        ),
        ("scores", score_shape, &[1, 300][..], scores.len(), QUERIES),
    ] {
        if actual != expected || len != count {
            return Err(format!("RT-DETR {name}: expected {expected:?} ({count} values), got {actual:?} ({len} values)"));
        }
    }
    let mut out = Vec::new();
    for i in 0..QUERIES {
        let class = match labels[i] {
            0 => Class::Bubble,
            1 => Class::TextBubble,
            2 => Class::TextFree,
            other => return Err(format!("RT-DETR unknown label {other}; expected 0, 1 or 2")),
        };
        let score = scores[i];
        let b = &boxes[i * 4..i * 4 + 4];
        if !score.is_finite()
            || score < CONFIDENCE
            || score > 1.0
            || b.iter().any(|v| !v.is_finite())
        {
            continue;
        }
        let bbox = [
            b[0].clamp(0.0, width as f32),
            b[1].clamp(0.0, height as f32),
            b[2].clamp(0.0, width as f32),
            b[3].clamp(0.0, height as f32),
        ];
        if bbox[2] - bbox[0] >= 6.0 && bbox[3] - bbox[1] >= 6.0 {
            out.push(Region::new(bbox, score, class));
        }
    }
    Ok(out)
}

fn area(b: [f32; 4]) -> f32 {
    (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0)
}

fn dedupe(mut regions: Vec<Region>) -> Vec<Region> {
    regions.sort_by(|a, b| {
        a.truncated
            .cmp(&b.truncated)
            .then_with(|| b.score.total_cmp(&a.score))
    });
    let mut kept: Vec<Region> = Vec::new();
    'next: for region in regions {
        for previous in &mut kept {
            if region.class != previous.class {
                continue;
            }
            let (a, b) = (region.bbox, previous.bbox);
            let (aa, ab) = (area(a).max(1.0), area(b).max(1.0));
            let ix = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
            let iy = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
            let shared = ix * iy / aa.min(ab);
            let ox = ix / (a[2] - a[0]).min(b[2] - b[0]).max(1.0);
            let oy = iy / (a[3] - a[1]).min(b[3] - b[1]).max(1.0);
            if region.truncated
                && previous.truncated
                && region.source != previous.source
                && shared > 0.25
                && (ox > 0.8 || oy > 0.8)
            {
                previous.bbox = [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[2].max(b[2]),
                    a[3].max(b[3]),
                ];
                continue 'next;
            }
            if (shared > 0.4 && aa.min(ab) / aa.max(ab) > 0.55)
                || (region.truncated && shared > 0.85 && aa < ab)
            {
                continue 'next;
            }
        }
        kept.push(region);
    }
    kept.sort_by(|a, b| {
        a.bbox[1]
            .total_cmp(&b.bbox[1])
            .then_with(|| a.bbox[0].total_cmp(&b.bbox[0]))
    });
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_arrays(labels: &[i64], boxes: &[f32], scores: &[f32]) -> Result<Vec<Region>, String> {
        decode(
            &[1, 300],
            labels,
            &[1, 300, 4],
            boxes,
            &[1, 300],
            scores,
            200,
            400,
        )
    }

    #[test]
    fn plain_resize_is_rgb_planar_without_letterbox_or_mean_normalization() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            17,
            5,
            image::Rgb([255, 128, 7]),
        ));
        let input = preprocess(&image).unwrap();
        let plane = INPUT_SIZE * INPUT_SIZE;
        assert_eq!(input.len(), 3 * plane);
        for (channel, expected) in [1.0, 128.0 / 255.0, 7.0 / 255.0].into_iter().enumerate() {
            assert!(input[channel * plane..(channel + 1) * plane]
                .iter()
                .all(|v| (*v - expected).abs() < 1e-6));
        }
        assert!(preprocess(&DynamicImage::new_rgb8(0, 0)).is_err());
    }

    #[test]
    fn synthetic_output_decodes_all_classes_clips_and_uses_original_pixel_coordinates() {
        let mut labels = vec![0; QUERIES];
        let mut boxes = vec![0.0; QUERIES * 4];
        let mut scores = vec![0.0; QUERIES];
        labels[..4].copy_from_slice(&[0, 1, 2, 1]);
        boxes[..16].copy_from_slice(&[
            -10.0, -20.0, 210.0, 420.0, 10.0, 20.0, 30.0, 60.0, 40.0, 80.0, 70.0, 90.0, 0.0, 0.0,
            100.0, 100.0,
        ]);
        scores[..4].copy_from_slice(&[0.9, 0.2, 0.7, 0.199]);
        let out = decode_arrays(&labels, &boxes, &scores).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].bbox, [0.0, 0.0, 200.0, 400.0]);
        assert_eq!(out[0].class, Class::Bubble);
        assert_eq!(out[1].bbox, [10.0, 20.0, 30.0, 60.0]);
        assert_eq!(out[1].class.kind(), Some("bubble"));
        assert_eq!(out[2].class.kind(), Some("free"));
    }

    #[test]
    fn tensor_contract_errors_name_surprising_shapes_types_and_labels() {
        let labels = vec![0; QUERIES];
        let boxes = vec![0.0; QUERIES * 4];
        let scores = vec![0.0; QUERIES];
        assert!(decode(
            &[300, 1],
            &labels,
            &[1, 300, 4],
            &boxes,
            &[1, 300],
            &scores,
            200,
            400
        )
        .unwrap_err()
        .contains("labels"));
        assert!(decode(
            &[1, 300],
            &labels,
            &[1, 4, 300],
            &boxes,
            &[1, 300],
            &scores,
            200,
            400
        )
        .unwrap_err()
        .contains("boxes"));
        assert!(decode_arrays(&labels, &boxes, &scores[..299])
            .unwrap_err()
            .contains("scores"));
        let mut unknown = labels;
        unknown[10] = 3;
        assert!(decode_arrays(&unknown, &boxes, &scores)
            .unwrap_err()
            .contains("unknown label 3"));
        assert!(check_names(
            &["boxes", "scores", "labels"],
            &["labels", "boxes", "scores"]
        )
        .is_ok());
        assert!(check_names(&["output0"], &["labels", "boxes", "scores"]).is_err());
        assert!(check_tensor(
            "images",
            TensorElementType::Float32,
            &[-1, 3, -1, -1],
            TensorElementType::Float32,
            &[1, 3, 640, 640]
        )
        .is_ok());
        assert!(check_tensor(
            "images",
            TensorElementType::Float32,
            &[1, 640, 640, 3],
            TensorElementType::Float32,
            &[1, 3, 640, 640]
        )
        .is_err());
        assert!(check_tensor(
            "labels",
            TensorElementType::Float32,
            &[1, 300],
            TensorElementType::Int64,
            &[1, 300]
        )
        .is_err());
    }

    #[test]
    fn invalid_predictions_do_not_become_regions() {
        let labels = vec![1; QUERIES];
        let mut boxes = vec![0.0; QUERIES * 4];
        let mut scores = vec![0.0; QUERIES];
        boxes[..16].copy_from_slice(&[
            f32::NAN,
            10.0,
            50.0,
            50.0,
            20.0,
            20.0,
            10.0,
            10.0,
            0.0,
            0.0,
            5.0,
            100.0,
            0.0,
            0.0,
            50.0,
            50.0,
        ]);
        scores[..4].copy_from_slice(&[0.9, 0.9, 0.9, f32::INFINITY]);
        assert!(decode_arrays(&labels, &boxes, &scores).unwrap().is_empty());
    }

    #[test]
    fn band_mapping_and_dedupe_keep_classes_and_merge_only_cross_band_fragments() {
        let mut a = Region::new([10.0, 50.0, 50.0, 150.0], 0.8, Class::TextBubble);
        a.place_band(0, 150, 400, 1);
        let mut b = Region::new([10.0, 0.0, 50.0, 100.0], 0.7, Class::TextBubble);
        b.place_band(120, 270, 400, 2);
        assert_eq!(b.bbox, [10.0, 120.0, 50.0, 220.0]);
        assert!(a.truncated && b.truncated);
        let union = dedupe(vec![a.clone(), b.clone()]);
        assert_eq!(union.len(), 1);
        assert_eq!(union[0].bbox, [10.0, 50.0, 50.0, 220.0]);
        b.source = 1;
        assert_eq!(dedupe(vec![a.clone(), b.clone()]).len(), 2);
        b.source = 2;
        b.class = Class::TextFree;
        assert_eq!(dedupe(vec![a.clone(), b]).len(), 2);
        let complete = Region::new([10.0, 40.0, 50.0, 230.0], 0.5, Class::TextBubble);
        assert_eq!(dedupe(vec![a, complete.clone()]), vec![complete]);
    }

    #[test]
    #[ignore = "requires cached rtdetr/detector.onnx; never downloads weights"]
    fn cached_model_has_the_expected_tensor_contract_and_runs() {
        let path = super::super::engine::default_models_dir().join("rtdetr/detector.onnx");
        assert!(
            path.is_file(),
            "RT-DETR model not cached: {}",
            path.display()
        );
        let mut detector = RtDetr::load(&path).unwrap();
        let page = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            200,
            600,
            image::Rgb([255, 255, 255]),
        ));
        let regions = detector.detect_page(&page).unwrap();
        eprintln!(
            "cached RT-DETR: {} regions on a blank tall page",
            regions.len()
        );
    }
}
