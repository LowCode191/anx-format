#!/usr/bin/env python3
"""Deterministic stub of scripts/rapidocr_bridge.py for tests.

Emits a schema-valid bridge payload without any OCR runtime so the
package-level candidate surface can be tested quickly and offline.
"""
import argparse
import hashlib
import json

parser = argparse.ArgumentParser()
parser.add_argument("--pdf", required=True)
parser.add_argument("--pages", required=True)
parser.add_argument("--policy", required=True)
parser.add_argument("--dpi", default="200")
parser.add_argument("--disable-adaptive", action="store_true")
args = parser.parse_args()

with open(args.pdf, "rb") as handle:
    pdf_sha = hashlib.sha256(handle.read()).hexdigest()

pages = []
for page in [int(value) for value in args.pages.split(",")]:
    text = f"STUB OCR PAGE {page} TOTAL $1,234.56 AND 42%"
    pages.append({
        "page": page,
        "text": text,
        "widthPixels": 850,
        "heightPixels": 1100,
        "meanConfidence": 0.91,
        "minimumConfidence": 0.88,
        "lineCount": 1,
        "lines": [{"text": text, "confidence": 0.91, "box": [10, 10, 800, 40]}],
        "engineElapsedMs": 5.0,
        "wallElapsedMs": 6.0,
    })

print(json.dumps({
    "schema": "agn.rapidocr-bridge-output.v1",
    "engine": {
        "name": "StubOCR",
        "version": "0.0.1",
        "runtime": "stub",
        "policyId": "stub-policy",
        "policySha256": "0" * 64,
        "processPeakRssBytes": 1024,
        "models": [{"role": "detection", "family": "stub", "variant": "stub", "file": "stub.onnx", "sha256": "0" * 64, "bytes": 1}],
    },
    "renderer": {"name": "stub-renderer", "version": "0.0.1", "dpi": int(args.dpi)},
    "pdfSha256": pdf_sha,
    "pages": pages,
}))
