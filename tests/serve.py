"""Start the real web app against disposable synthetic WAVs for Playwright."""

import json
import os
import sys
import wave
from pathlib import Path

import uvicorn


def main() -> None:
    output = Path(os.environ["UNDERSCORE_TEST_OUTPUT_DIR"])
    job = output / "000000000001"
    job.mkdir()
    for stem, sample in (("karaoke", b"\x00\x00"), ("vocals", b"\x01\x00")):
        with wave.open(str(job / f"{stem}.wav"), "wb") as wav:
            wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            wav.writeframes(sample * 8000 * 8)
    (job / "meta.json").write_text(json.dumps({"filename": "fixture.wav"}), encoding="utf-8")
    os.environ["UNDERSCORE_OUTPUT_DIR"] = str(output)
    os.environ.pop("UNDERSCORE_KEEP_JOBS", None)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    uvicorn.run("server:app", host="127.0.0.1", port=8765)


if __name__ == "__main__":
    main()
