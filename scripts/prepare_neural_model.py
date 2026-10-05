#!/usr/bin/env python3
"""Resolve complete, quantized public ONNX candidates before browser tests."""
import argparse
import json
from pathlib import Path
import re
from urllib.request import urlopen

CANDIDATES = {
    "glm": {"model": "onnx-community/GLM-OCR-ONNX", "name": "GLM-OCR", "label": "GLM-OCR"},
    "lighton": {"model": "onnx-community/LightOnOCR-2-1B-ONNX", "name": "LightOnOCR-2-1B", "label": "LightOnOCR"},
}
ROOTS = ["embed_tokens", "vision_encoder", "decoder_model_merged"]


def resolve(candidate):
    spec = CANDIDATES[candidate]
    with urlopen(f"https://huggingface.co/api/models/{spec['model']}?blobs=true", timeout=60) as response:
        metadata = json.load(response)
    revision = metadata["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid model revision")
    assets = {item["rfilename"]: item for item in metadata["siblings"]}
    selected = [name for name in assets if "/" not in name and name.endswith((".json", ".jinja"))]
    for root in ROOTS:
        name = f"onnx/{root}_q4.onnx"
        if name not in assets:
            raise ValueError(f"Missing required model asset: {name}")
        selected.append(name)
        selected.extend(path for path in assets if path.startswith(name + "_data"))
    sizes = {name: assets[name].get("size") or assets[name].get("lfs", {}).get("size", 0) for name in selected}
    if any(not isinstance(size, int) or size <= 0 for size in sizes.values()):
        raise ValueError("Model asset sizes could not be verified")
    total = sum(sizes.values())
    if total > 2_000_000_000:
        raise ValueError("Model exceeds the browser download budget")
    print(f"Locked {spec['model']}@{revision}: {total / 1048576:.1f} MiB, {len(selected)} assets")
    return {"available": True, **spec, "candidate": candidate, "revision": revision, "dtype": "q4", "bytes": total, "sizes": sizes}


def prepare(output: Path, candidate):
    output.parent.mkdir(parents=True, exist_ok=True)
    names = list(CANDIDATES) if candidate in ["auto", "all"] else [candidate]
    available, errors = [], {}
    for name in names:
        try:
            spec = resolve(name)
            available.append(spec)
            if candidate == "all":
                destination = output.parent / "neural-candidates" / f"{name}.json"
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(json.dumps(spec, indent=2) + "\n")
        except Exception as error:
            errors[name] = str(error)
            print(f"Candidate {name} cannot be enabled: {error}")
    (output.parent / "neural-candidate-errors.json").write_text(json.dumps(errors, indent=2) + "\n")
    if not available:
        raise RuntimeError("No complete ONNX candidate could be verified: " + json.dumps(errors))
    output.write_text(json.dumps(available[0], indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".cache/neural-model.json"))
    parser.add_argument("--candidate", choices=["auto", "all", *CANDIDATES], default="auto")
    arguments = parser.parse_args()
    prepare(arguments.output, arguments.candidate)
