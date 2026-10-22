"""The worker's insert pool: builds InsertJob rows (worker/inserts.py) in background threads, in parallel with renders.

Up to INSERT_PARALLEL (default 2) inserts at a time; only 1 while the CPU is busy (a render running in this worker, or
the machine's CPU over INSERT_CPU_BUSY percent). Each build is its own `python inserts.py build` process, so it never
blocks the render loop; its "PROGRESS x" lines go to InsertJob.progress.
"""
from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

import db
import storage

PARALLEL = int(os.environ.get("INSERT_PARALLEL", "2"))
CPU_BUSY = float(os.environ.get("INSERT_CPU_BUSY", "70"))
HERE = Path(__file__).resolve().parent

render_active = threading.Event()  # set by worker/main.py while a render runs


class _Cpu:
    """System-wide CPU use (%) since the previous call."""

    def __init__(self):
        self.last = self._times()

    @staticmethod
    def _times():
        if os.name == "nt":
            idle, kernel, user = (ctypes.c_ulonglong(), ctypes.c_ulonglong(), ctypes.c_ulonglong())
            ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user))
            return idle.value, kernel.value + user.value  # kernel time includes idle
        try:
            v = [int(x) for x in open("/proc/stat").readline().split()[1:]]
            return v[3] + v[4], sum(v)
        except Exception:
            return 0, 0

    def percent(self) -> float:
        cur = self._times()
        di, dt = cur[0] - self.last[0], cur[1] - self.last[1]
        self.last = cur
        return 0.0 if dt <= 0 else 100.0 * (1 - di / dt)


def _build(job):
    conn = db.connect()
    work = Path(tempfile.mkdtemp(prefix="rs-insert-"))
    t0 = time.time()
    try:
        spec = job["spec"]
        (work / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
        proc = subprocess.Popen([sys.executable, str(HERE / "inserts.py"), "build", "--spec", str(work / "spec.json"),
                                 "--out", str(work / "out")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        done = None
        last = 0.0
        assert proc.stdout
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("PROGRESS "):
                p = float(line.split()[1])
                if p - last >= 0.05:
                    last = p
                    db.insert_progress(conn, job["id"], round(p, 3))
            elif line.startswith("DONE "):
                done = json.loads(line[5:])
        err = proc.stderr.read() if proc.stderr else ""
        if proc.wait() != 0 or not done:
            raise RuntimeError((err.strip().splitlines() or ["inserts.py failed"])[-1][:500])
        base = f"inserts/{job['projectId']}/{job['hash']}"
        url = storage.put_file(f"{base}.webm", Path(done["out"]), "video/webm")
        front = storage.put_file(f"{base}-front.webm", Path(done["front"]), "video/webm") if done.get("front") else None
        db.insert_done(conn, job["id"], url, front)
        print(f"[insert] done {job['kind']} {job['hash']} in {time.time() - t0:.1f}s", flush=True)
    except Exception as exc:
        traceback.print_exc()
        db.insert_failed(conn, job, f"{type(exc).__name__}: {exc}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        conn.close()


def loop(poll: float = 1.5):
    cpu = _Cpu()
    running: list[threading.Thread] = []
    conn = None
    note = None
    while True:
        try:
            if conn is None or conn.closed:
                conn = db.connect()
            running = [t for t in running if t.is_alive()]
            pct = cpu.percent()
            busy = render_active.is_set() or pct > CPU_BUSY
            limit = 1 if busy else PARALLEL
            want = ("waiting: CPU busy, building one at a time" if busy else "waiting for a free slot") if len(running) >= limit else None
            if want != note:
                db.note_queued_inserts(conn, want)
                note = want
            while len(running) < limit:
                job = db.claim_insert(conn)
                if not job:
                    break
                print(f"[insert] {job['kind']} {job['hash']} ({len(running) + 1}/{limit}{', CPU busy' if busy else ''})", flush=True)
                t = threading.Thread(target=_build, args=(job,), daemon=True)
                t.start()
                running.append(t)
        except Exception:
            traceback.print_exc()
            try:
                conn and conn.close()
            except Exception:
                pass
            conn = None
            time.sleep(5)
        time.sleep(poll)


def start():
    threading.Thread(target=loop, daemon=True, name="insert-pool").start()


def waiter(conn, job, timeout=30 * 60):
    """render.run's wait_inserts: fill insert clips' src from built InsertJobs; block=True waits for the rest."""

    def wait(tl, block):
        clips = [c for t in tl["tracks"] if t["kind"] == "video" for c in t["clips"] if c.get("insert")]
        hashes = {c["insert"]["hash"] for c in clips}
        t0 = time.time()
        while True:
            rows = db.inserts_by_hash(conn, job["projectId"], hashes)
            for c in clips:  # (re)queue anything the web app didn't
                h = c["insert"]["hash"]
                if h not in rows:
                    db.queue_insert(conn, job["projectId"], job["userId"], h, c["insert"]["kind"], c["insert"]["spec"])
            rows = db.inserts_by_hash(conn, job["projectId"], hashes)
            for c in clips:
                r = rows.get(c["insert"]["hash"])
                if r and r["status"] == "done":
                    c["src"] = r["frontUrl"] if c["insert"].get("layer") == "front" else r["outputUrl"]
                elif r and r["status"] == "failed":
                    raise RuntimeError(f"insert {c.get('name') or r['kind']} failed: {r['error']}")
            left = [c for c in clips if not c.get("src")]
            if not left or not block:
                db.render_step(conn, job["id"], None)
                return tl
            if time.time() - t0 > timeout:
                raise RuntimeError(f"{len(left)} insert(s) still not built after {timeout // 60} min")
            done = sum(1 for r in rows.values() if r["status"] == "done")
            db.render_step(conn, job["id"], f"Rendered the layers under the inserts · waiting for {len(hashes) - done} insert(s)")
            time.sleep(2)

    return wait
