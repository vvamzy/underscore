"""
Vocal Extractor — local AI server.

Serves the web UI and runs Demucs (Meta's source-separation model) to split a song
into a karaoke (instrumental) track + isolated vocals.

Run with:  .venv\\Scripts\\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from queue import Queue

try:
    import psutil  # used for pause / resume / cancel of running subprocesses
except ImportError:  # pragma: no cover
    psutil = None

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
OUTPUT = ROOT / "output"
OUTPUT.mkdir(exist_ok=True)

MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # 300 MB
ALLOWED_MODELS = {"htdemucs", "htdemucs_ft"}
ALLOWED_DEVICES = {"auto", "cpu", "gpu"}
MAX_FINISHED_JOBS = 25

app = FastAPI(title="Vocal Extractor Server", docs_url="/api/docs")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Environment detection (background — importing torch can take a few seconds)
# ---------------------------------------------------------------------------
ENV: dict = {"device": None, "torch": None, "detecting": True}


def _detect() -> None:
    try:
        import torch  # type: ignore

        ENV["torch"] = torch.__version__
        ENV["device"] = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        ENV["torch"] = None
        ENV["device"] = "unavailable"
    ENV["detecting"] = False


threading.Thread(target=_detect, daemon=True, name="env-detect").start()

# ---------------------------------------------------------------------------
# Job queue (one separation job at a time — separation is CPU/GPU heavy)
# ---------------------------------------------------------------------------
jobs: dict[str, dict] = {}
queue: Queue[str] = Queue()


class JobCancelled(Exception):
    """Raised inside a job when the user cancels it mid-run."""


def _public(job: dict) -> dict:
    """Job dict without internal (non-JSON) fields."""
    return {k: v for k, v in job.items() if k not in ("raw", "pid", "cancelled")}


def _proc_tree(pid: int) -> list[psutil.Process]:
    """The subprocess plus everything it spawned (psych harmless when psutil is missing)."""
    if psutil is None:
        return []
    try:
        proc = psutil.Process(pid)
        return [proc, *proc.children(recursive=True)]
    except Exception:
        return []


def _terminate_tree(pid: int) -> None:
    for proc in _proc_tree(pid):
        try:
            proc.terminate()
        except Exception:
            pass


def _set_paused(pid: int, paused: bool) -> bool:
    """Suspend/resume a running subprocess tree on Windows/Unix. Returns False if unavailable."""
    if psutil is None or not pid:
        return False
    trees = _proc_tree(pid)
    if not trees:
        return False
    for proc in trees:
        try:
            (proc.suspend if paused else proc.resume)()
        except Exception:
            pass
    return True


def _prune() -> None:
    finished = [jid for jid, j in jobs.items() if j.get("status") in ("done", "error")]
    for jid in finished[: max(0, len(finished) - MAX_FINISHED_JOBS)]:
        jobs.pop(jid, None)
        shutil.rmtree(OUTPUT / jid, ignore_errors=True)


def _run_demucs(cmd: list[str], job: dict) -> int:
    """Run demucs, streaming its output into job['detail'] / job['percent']."""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        cwd=str(ROOT),
    )
    job["pid"] = proc.pid
    pct_re = re.compile(r"(\d{1,3})%")
    ansi_re = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            if job.get("cancelled"):
                _terminate_tree(proc.pid)
                raise JobCancelled()
            line = ansi_re.sub("", raw_line).strip()
            if not line:
                continue
            job["detail"] = line[:180]
            m = pct_re.search(line)
            if m:
                p = int(m.group(1))
                if 0 <= p <= 100:
                    job["percent"] = 10 + round(p * 0.85)
    finally:
        if proc.stdout:
            proc.stdout.close()
    rc = proc.wait()
    if job.get("cancelled"):
        raise JobCancelled()
    return rc


def _run_job(job: dict) -> None:
    jdir = OUTPUT / job["id"]
    jdir.mkdir(parents=True, exist_ok=True)
    raw: Path = job["raw"]
    wav = jdir / "input.wav"

    # 1) Normalise whatever the user uploaded to 44.1 kHz stereo WAV.
    job.update(status="running", detail="Decoding audio with ffmpeg…", percent=3)
    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(raw), "-vn", "-ac", "2", "-ar", "44100", str(wav)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if job.get("cancelled"):
        raise JobCancelled()
    if proc.returncode != 0 or not wav.exists():
        err = (proc.stderr or "").strip()
        raise RuntimeError(f"Could not decode that file: {err[:300] or 'unknown error'}")

    # 2) Run Demucs (retry on CPU if the GPU runs out of memory).
    detected = ENV.get("device")
    requested = job.get("device", "auto")
    if requested == "gpu":
        device = "cuda" if detected == "cuda" else "cpu"
    elif requested == "cpu":
        device = "cpu"
    else:  # auto
        device = detected if detected in ("cpu", "cuda") else "cpu"
    job["device_used"] = device
    sep_dir = jdir / "sep"
    job.update(
        status="running",
        detail=f"Loading model “{job['model']}” on {device.upper()}…",
        percent=8,
    )

    def demucs_cmd(dev: str) -> list[str]:
        return [
            sys.executable, "-m", "demucs",
            "--two-stems=vocals",
            "-n", job["model"],
            "-d", dev,
            "-o", str(sep_dir),
            str(wav),
        ]

    rc = _run_demucs(demucs_cmd(device), job)
    if rc != 0 and device == "cuda":
        job.update(detail="GPU ran out of memory — retrying on CPU…", percent=8)
        job["device_used"] = "cpu"
        rc = _run_demucs(demucs_cmd("cpu"), job)
    if job.get("cancelled"):
        raise JobCancelled()
    if rc != 0:
        raise RuntimeError(job.get("detail") or "Demucs failed — check the server log")

    # 3) Collect the stems.
    stem_dir = sep_dir / job["model"] / "input"
    ksrc = stem_dir / "no_vocals.wav"
    vsrc = stem_dir / "vocals.wav"
    if not ksrc.exists() or not vsrc.exists():
        raise RuntimeError("Separation finished but the stems were missing")

    job.update(percent=96, detail="Saving stems…")
    shutil.move(str(ksrc), str(jdir / "karaoke.wav"))
    shutil.move(str(vsrc), str(jdir / "vocals.wav"))

    # 4) Clean up intermediates.
    shutil.rmtree(sep_dir, ignore_errors=True)
    wav.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)

    job.update(
        status="done",
        percent=100,
        detail="Done",
        device_used=job.get("device_used"),
        result={
            "karaoke": f"/outputs/{job['id']}/karaoke.wav",
            "vocals": f"/outputs/{job['id']}/vocals.wav",
        },
    )


def _finish_cancelled(job: dict | None) -> None:
    if job is None:
        return
    job["cancelled"] = True
    job.update(status="cancelled", detail="Cancelled", percent=0)
    shutil.rmtree(OUTPUT / job["id"], ignore_errors=True)


def _worker() -> None:
    while True:
        jid = queue.get()
        job = jobs.get(jid)
        try:
            if job is None or job.get("cancelled"):
                _finish_cancelled(job)
                continue
            _run_job(job)
        except JobCancelled:
            _finish_cancelled(jobs.get(jid))
        except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
            if jobs.get(jid) is not None:
                jobs[jid].update(status="error", detail=str(exc))
        finally:
            queue.task_done()


threading.Thread(target=_worker, daemon=True, name="job-worker").start()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    detected = ENV.get("device")
    return {
        "ok": True,
        "demucs": importlib.util.find_spec("demucs") is not None,
        "device": detected,
        "cuda": detected == "cuda",
        "cpu": True,
        "detecting": ENV.get("detecting", True),
        "queue": queue.qsize(),
    }


@app.post("/api/separate")
async def separate(
    file: UploadFile = File(...),
    model: str = "htdemucs",
    device: str = "auto",
) -> dict:
    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail="Unknown model")
    if device not in ALLOWED_DEVICES:
        raise HTTPException(status_code=400, detail="Device must be auto, cpu or gpu")
    if device == "gpu" and ENV.get("device") != "cuda":
        raise HTTPException(
            status_code=400,
            detail="GPU separation was requested, but this server has no CUDA. "
                   "Run `setup.ps1 -Gpu` once, or pick CPU.",
        )

    jid = uuid.uuid4().hex[:12]
    jdir = OUTPUT / jid
    jdir.mkdir(parents=True, exist_ok=True)

    suffix = Path(file.filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", suffix or ""):
        suffix = ".bin"
    raw = jdir / f"raw{suffix}"

    size = 0
    with open(raw, "wb") as fh:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                fh.close()
                shutil.rmtree(jdir, ignore_errors=True)
                raise HTTPException(status_code=413, detail="File too large (300 MB max)")
            fh.write(chunk)

    if size == 0:
        shutil.rmtree(jdir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Empty file")

    job = {
        "id": jid,
        "status": "queued",
        "detail": "Waiting in queue…",
        "percent": 0,
        "model": model,
        "device": device,
        "filename": file.filename or "track",
        "raw": raw,
    }
    jobs[jid] = job
    _prune()
    queue.put(jid)
    return {"job_id": jid}


@app.get("/api/jobs/{jid}")
def get_job(jid: str) -> dict:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    out = _public(job)
    if job["status"] == "queued":
        out["position"] = _queued_position(jid)
    return out


def _queued_position(jid: str) -> int:
    """1-based position of this job in the processing line (running job = 1)."""
    pos = 0
    for other in jobs.values():
        if other["id"] == jid:
            return pos + 1
        if other["status"] in ("queued", "running"):
            pos += 1
    return pos + 1


@app.get("/api/queue")
def get_queue() -> dict:
    """Current server queue — everything from waitlist to finished jobs."""
    items = [_public(j) | {"position": _queued_position(j["id"])} for j in jobs.values()]
    return {"jobs": items}


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str) -> dict:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    if job["status"] in ("done", "cancelled"):
        return {"ok": True, "status": job["status"]}
    job["cancelled"] = True
    if job["status"] == "queued":
        job.update(status="cancelled", detail="Cancelled")
        return {"ok": True, "status": "cancelled"}
    # Running — kill the process tree; the worker marks it cancelled.
    _terminate_tree(job.get("pid") or 0)
    job.update(detail="Cancelling…")
    return {"ok": True, "status": "cancelling"}


@app.post("/api/jobs/{jid}/pause")
def pause_job(jid: str) -> dict:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    if job["status"] != "running":
        raise HTTPException(status_code=409, detail="Only a running job can be paused")
    if not _set_paused(job.get("pid") or 0, paused=True):
        raise HTTPException(status_code=409, detail="Pause unavailable (psutil missing or process gone)")
    job["paused"] = True
    job.update(detail="Paused — press resume to continue")
    return {"ok": True, "status": "paused"}


@app.post("/api/jobs/{jid}/resume")
def resume_job(jid: str) -> dict:
    job = jobs.get(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    if job["status"] != "running":
        raise HTTPException(status_code=409, detail="Only a running (paused) job can be resumed")
    _set_paused(job.get("pid") or 0, paused=False)
    job["paused"] = False
    job.pop("paused_detail", None)
    return {"ok": True, "status": "running"}


@app.post("/api/mp3")
async def to_mp3(file: UploadFile = File(...), name: str = "track") -> FileResponse:
    """Convert an uploaded audio blob to MP3 (using the local ffmpeg)."""
    tmp = OUTPUT / f".mp3-{uuid.uuid4().hex}"
    tmp.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "").suffix.lower() or ".wav"
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", suffix):
        suffix = ".wav"
    src = tmp / f"in{suffix}"
    dst = tmp / "out.mp3"

    size = 0
    with open(src, "wb") as fh:
        while True:
            chunk = await file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                shutil.rmtree(tmp, ignore_errors=True)
                raise HTTPException(status_code=413, detail="File too large")
            fh.write(chunk)

    proc = subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-i", str(src), "-vn", "-codec:a", "libmp3lame", "-q:a", "2", str(dst)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0 or not dst.exists():
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status_code=500, detail=(proc.stderr or "ffmpeg failed")[:300])

    safe = re.sub(r'[\\/:*?"<>|]+', "_", name).strip() or "track"
    return FileResponse(
        dst,
        media_type="audio/mpeg",
        filename=f"{safe}.mp3",
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )


# ---------------------------------------------------------------------------
# Static files (mounted last so API routes win)
# ---------------------------------------------------------------------------
app.mount("/outputs", StaticFiles(directory=OUTPUT), name="outputs")
app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
