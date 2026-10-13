#!/usr/bin/env python3
"""Render selected PDF pages and return reproducible RapidOCR candidates as JSON."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import resource
import sys
import time


def _box_metrics(box: list[list[float]]) -> dict[str, float]:
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    return {
        "left": min(xs),
        "right": max(xs),
        "top": min(ys),
        "bottom": max(ys),
        "center_y": (min(ys) + max(ys)) / 2.0,
        "height": max(1.0, max(ys) - min(ys)),
    }


def logical_lines(texts: list[str], scores: list[float], boxes: list[list[list[float]]]) -> list[dict[str, object]]:
    """Return stable top-to-bottom, left-to-right logical lines.

    OCR detectors are not obligated to return reading order, and may split a
    single visual line into several overlapping detections. Geometry is the
    authority for ordering; recognized characters are never guessed or
    rewritten here. Raw fragments remain attached to every logical line.
    """
    detections = []
    for index, text in enumerate(texts):
        if index >= len(boxes) or not str(text).strip():
            continue
        box = [[round(float(x), 3), round(float(y), 3)] for x, y in boxes[index]]
        detections.append({
            "text": str(text).strip(),
            "confidence": round(float(scores[index]), 6) if index < len(scores) else 0.0,
            "box": box,
            "metrics": _box_metrics(box),
        })
    detections.sort(key=lambda item: (item["metrics"]["center_y"], item["metrics"]["left"]))
    rows: list[dict[str, object]] = []
    for detection in detections:
        metrics = detection["metrics"]
        eligible = [
            row for row in rows
            if abs(float(row["center_y"]) - metrics["center_y"])
            <= max(8.0, 0.58 * max(float(row["height"]), metrics["height"]))
        ]
        if eligible:
            row = min(eligible, key=lambda item: abs(float(item["center_y"]) - metrics["center_y"]))
            fragments = row["fragments"]
            fragments.append(detection)
            row["center_y"] = sum(fragment["metrics"]["center_y"] for fragment in fragments) / len(fragments)
            row["height"] = max(float(row["height"]), metrics["height"])
        else:
            rows.append({"center_y": metrics["center_y"], "height": metrics["height"], "fragments": [detection]})
    rows.sort(key=lambda row: (min(fragment["metrics"]["top"] for fragment in row["fragments"]), min(fragment["metrics"]["left"] for fragment in row["fragments"])))
    output = []
    for row in rows:
        fragments = sorted(row["fragments"], key=lambda item: (item["metrics"]["left"], item["metrics"]["top"]))
        left = min(fragment["metrics"]["left"] for fragment in fragments)
        right = max(fragment["metrics"]["right"] for fragment in fragments)
        top = min(fragment["metrics"]["top"] for fragment in fragments)
        bottom = max(fragment["metrics"]["bottom"] for fragment in fragments)
        output.append({
            "text": " ".join(fragment["text"] for fragment in fragments),
            "confidence": round(sum(float(fragment["confidence"]) for fragment in fragments) / len(fragments), 6),
            "box": [[left, top], [right, top], [right, bottom], [left, bottom]],
            "fragments": [{"text": fragment["text"], "confidence": fragment["confidence"], "box": fragment["box"]} for fragment in fragments],
        })
    return output


def run_page(engine: object, page: object, dpi: int) -> dict[str, object]:
    started = time.perf_counter()
    bitmap = page.render(scale=dpi / 72.0)
    rgb = bitmap.to_numpy()
    bgr = rgb[:, :, ::-1].copy() if rgb.ndim == 3 and rgb.shape[2] >= 3 else rgb
    result = engine(bgr)
    texts = list(result.txts or ())
    scores = [float(value) for value in (result.scores or ())]
    boxes = result.boxes.tolist() if result.boxes is not None else []
    lines = logical_lines(texts, scores, boxes)
    return {
        "widthPixels": int(rgb.shape[1]),
        "heightPixels": int(rgb.shape[0]),
        "text": "\n".join(str(line["text"]) for line in lines),
        "meanConfidence": round(sum(scores) / len(scores), 6) if scores else 0.0,
        "minimumConfidence": round(min(scores), 6) if scores else 0.0,
        "lineCount": len(lines),
        "rawLineCount": len(texts),
        "fragmentationRatio": round(len(texts) / len(lines), 6) if lines else 0.0,
        "lines": lines,
        "engineElapsedMs": round(float(result.elapse or 0.0) * 1000.0, 3),
        "wallElapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
        "renderDpi": dpi,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_pages(value: str) -> list[int]:
    pages = sorted({int(item) for item in value.split(",") if item.strip()})
    if not pages or pages[0] < 1:
        raise ValueError("--pages must contain one-based positive page numbers")
    return pages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--pages", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--dpi", type=int)
    parser.add_argument("--disable-adaptive", action="store_true")
    args = parser.parse_args()

    policy_path = Path(args.policy).resolve()
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    expected_version = str(policy["engineVersion"])

    from rapidocr import RapidOCR
    from rapidocr.utils.typings import LangDet, LangRec, OCRVersion
    import pypdfium2 as pdfium
    import rapidocr

    actual_version = importlib.metadata.version("rapidocr")
    if actual_version != expected_version:
        raise RuntimeError(f"RapidOCR version {actual_version} does not match pinned {expected_version}")

    parameters = policy["parameters"]
    engine = RapidOCR(params={
        "Global.use_cls": bool(parameters["useClassification"]),
        "Global.text_score": float(parameters["textScore"]),
        "Global.max_side_len": int(parameters["maximumImageSide"]),
        "Global.log_level": "warning",
        "EngineConfig.onnxruntime.intra_op_num_threads": int(parameters["intraOpThreads"]),
        "EngineConfig.onnxruntime.inter_op_num_threads": int(parameters["interOpThreads"]),
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.lang_type": LangDet.CH,
        "Det.limit_side_len": int(parameters["detectorLimitSide"]),
        "Det.limit_type": str(parameters["detectorLimitType"]),
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.lang_type": LangRec.EN,
    })

    models_dir = Path(rapidocr.__file__).resolve().parent / "models"
    models = []
    for expected in policy["models"]:
        model_path = models_dir / expected["file"]
        if not model_path.is_file():
            raise RuntimeError(f"RapidOCR did not resolve required model {expected['file']}")
        actual_hash = sha256_file(model_path)
        if actual_hash != expected["sha256"]:
            raise RuntimeError(f"Model hash mismatch for {expected['file']}: {actual_hash}")
        models.append({
            "role": expected["role"],
            "family": expected["family"],
            "variant": expected["variant"],
            "file": expected["file"],
            "sha256": actual_hash,
            "bytes": model_path.stat().st_size,
        })

    dpi = int(args.dpi or policy["render"]["dpi"])
    if dpi < 72 or dpi > 400:
        raise ValueError("DPI must be between 72 and 400")
    pdf_path = Path(args.pdf).resolve()
    document = pdfium.PdfDocument(pdf_path)
    pages = parse_pages(args.pages)
    if pages[-1] > len(document):
        raise ValueError(f"Page {pages[-1]} exceeds PDF page count {len(document)}")

    adaptive = policy["render"].get("adaptive", {})
    adaptive_configured = bool(adaptive.get("enabled", False))
    adaptive_enabled = adaptive_configured and not args.disable_adaptive
    adaptive_dpi = int(adaptive.get("dpi", dpi))
    fragmentation_threshold = float(adaptive.get("fragmentationRatioThreshold", 2.2))
    candidates = []
    for page_number in pages:
        page = document[page_number - 1]
        initial = run_page(engine, page, dpi)
        selected = initial
        variants = [{"dpi": dpi, "rawLineCount": initial["rawLineCount"], "lineCount": initial["lineCount"], "fragmentationRatio": initial["fragmentationRatio"], "meanConfidence": initial["meanConfidence"], "engineElapsedMs": initial["engineElapsedMs"], "wallElapsedMs": initial["wallElapsedMs"]}]
        escalation_reason = None
        if adaptive_enabled and adaptive_dpi != dpi and float(initial["fragmentationRatio"]) > fragmentation_threshold:
            escalated = run_page(engine, page, adaptive_dpi)
            variants.append({"dpi": adaptive_dpi, "rawLineCount": escalated["rawLineCount"], "lineCount": escalated["lineCount"], "fragmentationRatio": escalated["fragmentationRatio"], "meanConfidence": escalated["meanConfidence"], "engineElapsedMs": escalated["engineElapsedMs"], "wallElapsedMs": escalated["wallElapsedMs"]})
            selected = dict(escalated)
            selected["engineElapsedMs"] = round(float(initial["engineElapsedMs"]) + float(escalated["engineElapsedMs"]), 3)
            selected["wallElapsedMs"] = round(float(initial["wallElapsedMs"]) + float(escalated["wallElapsedMs"]), 3)
            escalation_reason = f"base fragmentation ratio {initial['fragmentationRatio']} exceeded {fragmentation_threshold}"
        candidates.append({
            "page": page_number,
            **selected,
            "resolutionEscalated": escalation_reason is not None,
            "resolutionEscalationReason": escalation_reason,
            "resolutionVariants": variants,
        })

    output = {
        "schema": "agn.rapidocr-bridge-output.v1",
        "engine": {
            "name": "RapidOCR",
            "version": actual_version,
            "runtime": "onnxruntime",
            "policyId": policy["id"],
            "policySha256": sha256_file(policy_path),
            "models": models,
            "processPeakRssBytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)),
        },
        "renderer": {
            "name": "pypdfium2",
            "version": importlib.metadata.version("pypdfium2"),
            "dpi": dpi,
            "adaptiveDpi": adaptive_dpi if adaptive_configured else None,
            "fragmentationRatioThreshold": fragmentation_threshold if adaptive_configured else None,
        },
        "pdfSha256": sha256_file(pdf_path),
        "pages": candidates,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
