#!/usr/bin/env python3
"""Verify the authorized diagnostic archive and import data only into a new folder."""
import argparse
import hashlib
import json
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

EXPECTED_SHA256 = "280c6b0eec0d77aca8a122d46731663cbe63f51c7d4db8221daf8b94ee396a99"
PREFIX = "project-01-spatial-exploration-2026-10-12/"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    digest = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    assert digest == EXPECTED_SHA256, "archive differs from the supported 2026-10-14 transfer"
    assert not args.destination.exists(), "destination must be new"
    with zipfile.ZipFile(args.archive) as archive:
        infos = archive.infolist()
        assert len(infos) == 80 and len({i.filename for i in infos}) == 80
        for info in infos:
            name = PurePosixPath(info.filename)
            assert not name.is_absolute() and ".." not in name.parts
            assert "\\" not in info.filename and info.filename.startswith(PREFIX)
            assert not stat.S_ISLNK(info.external_attr >> 16)
            assert info.file_size < 10_000_000
        assert archive.testzip() is None, "ZIP CRC failure"
        covered = set()
        for line in archive.read(PREFIX + "SHA256SUMS").decode().splitlines():
            expected, name = line.split(maxsplit=1)
            name = name.lstrip("*")
            full = PREFIX + name
            assert hashlib.sha256(archive.read(full)).hexdigest() == expected, name
            covered.add(full)
        assert covered == set(archive.namelist()) - {PREFIX + "SHA256SUMS"}
        provenance = {}
        for name, key in [(".baseline-main-provenance.json", "files"),
                          ("runner-snapshot/.snapshot-provenance.json", "verified_blobs")]:
            record = json.loads(archive.read(PREFIX + name))
            for row in record[key]:
                relative = row.get("archivePath", "runner-snapshot/" + row.get("path", ""))
                data = archive.read(PREFIX + relative)
                blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                assert blob == row.get("gitBlob", row.get("sha")), relative
            provenance[name] = {"commit": record["commit"], "verified_blobs": len(record[key])}
        generated = PREFIX + "exploration/generated/"
        manifest = json.loads(archive.read(generated + "manifest.json"))
        assert len(manifest) == 14 and len({item["id"] for item in manifest}) == 14
        hashes = json.loads(archive.read(generated + "hashes.json"))
        assert len(hashes) == 23
        for name, expected in hashes.items():
            assert hashlib.sha256(archive.read(generated + name)).hexdigest() == expected, name
        selected = [info for info in infos if info.filename.startswith(generated + "tasks/")]
        assert len(selected) == 22
        assert sum(info.filename.endswith(".json") for info in selected) == 14
        assert sum(info.filename.endswith(".png") for info in selected) == 8
        args.destination.mkdir(parents=True)
        for info in selected:
            target = args.destination / info.filename.removeprefix(generated + "tasks/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))
    print(json.dumps({"timestamp_utc": datetime.now(timezone.utc).isoformat(),
                      "status": "PASS", "archive_sha256": digest,
                      "archive_files": 80, "manifest_checksums": len(covered),
                      "generated_checksums": len(hashes), "fixtures": 14, "images": 8,
                      "provenance": provenance, "destination": str(args.destination)}, indent=2))


if __name__ == "__main__":
    main()
