"""Render pool heartbeat: tells the app which PCs are running a worker and what each is doing.

Every worker upserts its "PoolNode" row every 15 s from a background thread, so any number of PCs can share one
database (jobs are claimed with FOR UPDATE SKIP LOCKED in db.py). The app treats a row older than 45 s as offline.
"""
from __future__ import annotations

import os
import platform
import threading
import traceback

import db

BEAT = 15.0
NODE_ID = os.environ.get("POOL_NODE_ID") or platform.node() or "worker"
NODE_NAME = os.environ.get("POOL_NODE_NAME") or NODE_ID

_state = {"status": "idle", "job": None}
_wake = threading.Event()


def busy(job: str):
    _state.update(status="busy", job=job)
    _wake.set()


def idle():
    _state.update(status="idle", job=None)
    _wake.set()


def _beat(conn):
    conn.execute(
        """INSERT INTO "PoolNode" (id, name, host, status, job, "startedAt", "lastSeen")
           VALUES (%s, %s, %s, %s, %s, now(), now())
           ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, host=EXCLUDED.host, status=EXCLUDED.status,
             job=EXCLUDED.job, "lastSeen"=now()""",
        (NODE_ID, NODE_NAME, platform.node(), _state["status"], _state["job"]),
    )


def _run():
    conn = None
    while True:
        try:
            if conn is None or conn.closed:
                conn = db.connect()
            _beat(conn)
        except Exception:
            traceback.print_exc()
            conn = None
        _wake.wait(BEAT)
        _wake.clear()


def start():
    # The first beat also resets startedAt, so the app shows how long this session has been online.
    try:
        with db.connect() as conn:
            conn.execute('DELETE FROM "PoolNode" WHERE id=%s', (NODE_ID,))
    except Exception:
        traceback.print_exc()
    threading.Thread(target=_run, name="pool-heartbeat", daemon=True).start()
    print(f"[pool] joined as {NODE_NAME!r} ({NODE_ID})", flush=True)
