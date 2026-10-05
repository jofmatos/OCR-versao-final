#!/usr/bin/env python3
"""Publish only the best candidate that passes actual browser OCR checks."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

cache = Path(".cache")
artifacts = Path("test-results/neural")
artifacts.mkdir(parents=True, exist_ok=True)
results, passed = [], []
failures = json.loads((cache / "neural-candidate-errors.json").read_text())
for candidate, error in failures.items():
    results.append({"candidate": candidate, "status": "unavailable", "error": error})
for index, source in enumerate(sorted((cache / "neural-candidates").glob("*.json"))):
    spec = json.loads(source.read_text())
    shutil.copyfile(source, cache / "neural-model.json")
    destination = artifacts / spec["candidate"]
    print(f"Testing {spec['name']} with actual weights in Chromium/WebGPU", flush=True)
    try:
        subprocess.run(["npm", "run", "build"], check=True)
        command = [sys.executable, "scripts/smoke_neural_browser.py", "--artifacts", str(destination)]
        if not passed:
            command.append("--baseline")
        subprocess.run(command, check=True, timeout=1800)
        report = json.loads((destination / "report.json").read_text())
        result = {"candidate": spec["candidate"], "status": "passed", "bytes": spec["bytes"], **report}
        results.append(result)
        passed.append((spec, report))
    except Exception as error:
        detail = (destination / "model-error.txt").read_text() if (destination / "model-error.txt").exists() else str(error)
        results.append({"candidate": spec["candidate"], "model": spec["name"], "status": "failed", "error": detail})
        print(f"Candidate {spec['name']} rejected: {detail}", flush=True)
        if os.environ.get("GITHUB_ACTIONS"):
            message = detail[:2000].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::warning title={spec['name']} rejected::{message}", flush=True)
(artifacts / "comparison.json").write_text(json.dumps(results, indent=2) + "\n")
if not passed:
    raise RuntimeError("No candidate passed real browser OCR. The existing site will remain deployed.")
highest = max(report["portuguese_similarity"] for spec, report in passed)
# Sub-character differences in this small fixture are not a useful ranking.
# Prefer the candidate that explicitly supports Portuguese on an effective tie.
eligible = [(spec, report) for spec, report in passed if highest - report["portuguese_similarity"] <= .005]
spec, report = min(eligible, key=lambda item: (item[0]["candidate"] != "lighton", item[0]["bytes"]))
spec["validation"] = report
(cache / "neural-model.json").write_text(json.dumps(spec, indent=2) + "\n")
(cache / "neural-comparison.json").write_text(json.dumps({"selected": spec["name"], "results": results, "limitation": "Synthetic Portuguese fixture; not a benchmark of the user's PDFs or actual iOS devices."}, indent=2) + "\n")
print(f"Selected {spec['name']}: Portuguese similarity {report['portuguese_similarity']:.3f}, {spec['bytes'] / 1048576:.1f} MiB", flush=True)
if os.environ.get("GITHUB_OUTPUT"):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"model_name={spec['name']}\nmodel_mib={spec['bytes'] / 1048576:.0f}\n")
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("## Actual browser OCR comparison\n\n| Model | Status | Portuguese similarity |\n| --- | --- | --- |\n")
        for result in results:
            score = result.get("portuguese_similarity")
            value = f"{score:.3f}" if score is not None else "not measured"
            summary.write(f"| {result.get('model', result['candidate'])} | {result['status']} | {value} |\n")
        summary.write(f"\nSelected **{spec['name']}**. Synthetic Portuguese fixture; no claim of universal superiority or iOS hardware validation.\n")
