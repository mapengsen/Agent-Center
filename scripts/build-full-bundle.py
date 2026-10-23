#!/usr/bin/env python3
"""Combine committed sources and the matching VSIX runtime into one download."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parent.parent


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vsix", type=Path, help="Matching VSIX; defaults to vsix/ or the project root")
    parser.add_argument("--output", type=Path, help="Output ZIP; defaults to vsix/Agent-Center-<version>-full.zip")
    args = parser.parse_args()
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    if git("diff", "--name-only").strip() or git("diff", "--cached", "--name-only").strip():
        raise SystemExit("Commit tracked changes before building a bundle with an exact source commit.")
    if git("ls-files", "--others", "--exclude-standard").strip():
        raise SystemExit("Commit or ignore untracked files before building the full bundle.")
    name = "{}-{}.vsix".format(package["name"], version)
    vsix = args.vsix
    if vsix is None:
        vsix = next((p for p in [ROOT / "vsix" / name, ROOT / name] if p.is_file()), None)
    if vsix is None or not vsix.is_file():
        raise SystemExit("Build the VSIX first with npm run package, or pass --vsix.")
    output = args.output or ROOT / "vsix" / "Agent-Center-{}-full.zip".format(version)
    if output.resolve() == vsix.resolve():
        raise SystemExit("The output must not overwrite the VSIX.")
    source_names = git("ls-files", "-z").decode("utf-8").rstrip("\0").split("\0")
    files = {}
    with zipfile.ZipFile(io.BytesIO(git("-c", "core.autocrlf=false", "archive", "--format=zip", "HEAD"))) as source:
        archived_names = {name for name in source.namelist() if not name.endswith("/")}
        if archived_names != set(source_names):
            raise SystemExit("The source archive does not include every tracked project file.")
        for relative in source_names:
            files[relative] = source.read(relative)
    runtime_names = []
    with zipfile.ZipFile(vsix) as archive:
        shipped = json.loads(archive.read("extension/package.json"))
        if shipped != package:
            raise SystemExit("The VSIX manifest does not match the committed project manifest.")
        for name_in_zip in archive.namelist():
            if name_in_zip.endswith("/") or not name_in_zip.startswith(("extension/out/", "extension/node_modules/")):
                continue
            relative = name_in_zip[len("extension/"):]
            if ".." in Path(relative).parts or Path(relative).is_absolute():
                raise SystemExit("Invalid runtime path in VSIX.")
            if relative in files:
                raise SystemExit("Runtime path conflicts with tracked source: " + relative)
            content = archive.read(name_in_zip)
            local = ROOT / relative
            if relative.startswith("out/") and local.is_file() and local.read_bytes() != content:
                raise SystemExit("Compiled output differs from the VSIX: " + relative)
            files[relative] = content
            runtime_names.append(relative)
    vsix_content = vsix.read_bytes()
    files["vsix/" + vsix.name] = vsix_content
    manifest = {
        "version": version,
        "sourceCommit": git("rev-parse", "HEAD").decode("ascii").strip(),
        "sourceFiles": source_names,
        "runtimeFiles": sorted(runtime_names),
        "vsixSha256": hashlib.sha256(vsix_content).hexdigest(),
    }
    files["SOURCE-MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, content in sorted(files.items()):
            archive.writestr("Agent-Center/" + relative, content)
    print(json.dumps({"output": str(output), "version": version, "sourceFiles": len(source_names),
                      "runtimeFiles": len(runtime_names), "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
