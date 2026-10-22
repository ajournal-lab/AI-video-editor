"""ReelSmith worker: polls Postgres for transcription and render jobs.

  python worker/main.py            # loop forever
  python worker/main.py --once     # process whatever is queued, then exit
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _load_env():
    """Read ../.env for local runs (docker-compose passes env vars directly)."""
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


_load_env()

import db  # noqa: E402
import insert_pool  # noqa: E402
import render  # noqa: E402
import storage  # noqa: E402
from media import normalize_audio, peaks, probe  # noqa: E402
from transcribe import transcribe  # noqa: E402

POLL = float(os.environ.get("WORKER_POLL_SECONDS", "2"))


def process_voice(conn, voice):
    print(f"[voice] {voice['id']} project={voice['projectId']}", flush=True)
    work = Path(tempfile.mkdtemp(prefix="rs-voice-"))
    try:
        src = storage.fetch(voice["url"], work / "in")
        norm = work / "voice.m4a"
        normalize_audio(src, str(norm))
        info = probe(str(norm))
        prefix = (voice.get("assetId") or voice["id"])[-6:]
        tr = transcribe(str(norm), prefix)
        duration = info["duration"] or tr["duration"]
        tr["duration"] = duration
        key = f"voice/{voice['projectId']}/{voice['id']}.m4a"
        url = storage.put_file(key, norm, "audio/mp4")
        db.voice_done(conn, voice, url=url, duration=duration, language=tr["language"], transcript=tr,
                      peaks=peaks(str(norm)))
        print(f"[voice] done: {len(tr['words'])} words, {duration:.1f}s", flush=True)
    except Exception as exc:
        traceback.print_exc()
        db.voice_failed(conn, voice, f"{type(exc).__name__}: {exc}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def process_render(conn, job):
    print(f"[render] {job['id']} project={job['projectId']} {job['quality']}", flush=True)
    work = Path(tempfile.mkdtemp(prefix="rs-render-"))
    try:
        tl = db.version_json(conn, job["versionId"])
        if not tl:
            raise RuntimeError("timeline version not found")
        last = [0.0]

        def on_progress(p):
            if p - last[0] >= 0.02:
                last[0] = p
                db.render_progress(conn, job["id"], round(p, 3))

        def on_preview(path):
            pkey = f"renders/{job['projectId']}/{job['id']}-phone.mp4"
            db.render_preview(conn, job["id"], storage.put_file(pkey, path, "video/mp4"), pkey)

        insert_pool.render_active.set()  # inserts build one at a time while a render runs
        out, thumb, duration, report = render.run(tl, job["quality"], lambda u: storage.fetch(u, work / "media"), work,
                                                  on_progress, on_preview, insert_pool.waiter(conn, job))
        key = f"renders/{job['projectId']}/{job['id']}.mp4"
        url = storage.put_file(key, out, "video/mp4")
        thumb_url = storage.put_file(f"renders/{job['projectId']}/{job['id']}.jpg", thumb, "image/jpeg") if thumb else None
        db.render_done(conn, job, url=url, key=key, thumb_url=thumb_url, duration=duration, report=report)
        print(f"[render] done {url}", flush=True)
    except Exception as exc:
        traceback.print_exc()
        db.render_failed(conn, job, f"{type(exc).__name__}: {exc}")
    finally:
        insert_pool.render_active.clear()
        if not os.environ.get("KEEP_RENDER_DIRS"):
            shutil.rmtree(work, ignore_errors=True)
        else:
            print(f"[render] kept {work}", flush=True)


def main():
    once = "--once" in sys.argv
    print(f"[worker] storage={storage._driver()} poll={POLL}s inserts<={insert_pool.PARALLEL} parallel", flush=True)
    if not once:
        insert_pool.start()
    conn = None
    while True:
        try:
            if conn is None or conn.closed:
                conn = db.connect()
            did = False
            voice = db.claim_voice(conn)
            if voice:
                process_voice(conn, voice)
                did = True
            job = db.claim_render(conn)
            if job:
                process_render(conn, job)
                did = True
            if not did:
                if once:
                    return
                time.sleep(POLL)
        except KeyboardInterrupt:
            return
        except Exception:
            traceback.print_exc()
            try:
                conn and conn.close()
            except Exception:
                pass
            conn = None
            time.sleep(5)


if __name__ == "__main__":
    main()
