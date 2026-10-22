"""Postgres access for the worker (tables are defined by prisma/schema.prisma)."""
from __future__ import annotations

import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

# Prisma-only URL params that libpq rejects.
_PRISMA_PARAMS = {"schema", "pgbouncer", "connection_limit", "pool_timeout", "socket_timeout", "statement_cache_size"}


def _dsn() -> str:
    url = os.environ["DATABASE_URL"]
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query) if k not in _PRISMA_PARAMS]
    return urlunsplit(parts._replace(query=urlencode(q)))


def connect():
    # Prisma stores timestamps as UTC in "timestamp without time zone" columns: the worker's now() must be UTC too,
    # or finishedAt / lockedAt land hours off (Postgres runs in local time on Windows installs)
    return psycopg.connect(_dsn(), row_factory=dict_row, autocommit=True, options="-c TimeZone=UTC")


STALE = "interval '20 minutes'"


def claim_voice(conn):
    return conn.execute(f"""
        UPDATE "VoiceTrack" SET status='processing', "lockedAt"=now(), attempts=attempts+1, "updatedAt"=now()
        WHERE id = (
          SELECT id FROM "VoiceTrack"
          WHERE (status='queued' OR (status='processing' AND "lockedAt" < now() - {STALE})) AND attempts < 3
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *""").fetchone()


def claim_render(conn):
    return conn.execute(f"""
        UPDATE "RenderJob" SET status='processing', "lockedAt"=now(), "startedAt"=now(), attempts=attempts+1, progress=0
        WHERE id = (
          SELECT id FROM "RenderJob"
          WHERE (status='queued' OR (status='processing' AND "lockedAt" < now() - {STALE})) AND attempts < 3
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *""").fetchone()


def voice_done(conn, voice, *, url, duration, language, transcript, peaks):
    with conn.transaction():
        conn.execute("""UPDATE "VoiceTrack" SET status='done', url=%s, duration=%s, language=%s,
                        "transcriptJson"=%s, error=NULL, "updatedAt"=now() WHERE id=%s""",
                     (url, duration, language, Jsonb(transcript), voice["id"]))
        if voice.get("assetId"):
            conn.execute("""UPDATE "MediaAsset" SET url=%s, duration=%s, mime='audio/mp4',
                            meta=COALESCE(meta, '{}'::jsonb) || %s WHERE id=%s""",
                         (url, duration, Jsonb({"peaks": peaks, "peaksPerSec": 50}), voice["assetId"]))
        conn.execute("""UPDATE "Project" SET status='transcribed', duration=%s, "statusMessage"=NULL, "updatedAt"=now()
                        WHERE id=%s AND status IN ('transcribing','failed')""", (duration, voice["projectId"]))


def voice_failed(conn, voice, error: str):
    final = voice["attempts"] >= 3
    conn.execute("""UPDATE "VoiceTrack" SET status=%s, error=%s, "updatedAt"=now() WHERE id=%s""",
                 ("failed" if final else "queued", error[:2000], voice["id"]))
    if final:
        conn.execute("""UPDATE "Project" SET status='failed', "statusMessage"=%s, "updatedAt"=now() WHERE id=%s""",
                     ("Transcription failed: " + error[:300], voice["projectId"]))


def version_json(conn, version_id: str):
    row = conn.execute('SELECT json FROM "TimelineVersion" WHERE id=%s', (version_id,)).fetchone()
    return row["json"] if row else None


def render_progress(conn, job_id: str, progress: float):
    conn.execute('UPDATE "RenderJob" SET progress=%s, "lockedAt"=now() WHERE id=%s', (progress, job_id))


def render_preview(conn, job_id: str, url: str, key: str):
    conn.execute('UPDATE "RenderJob" SET "previewUrl"=%s, "previewKey"=%s WHERE id=%s', (url, key, job_id))


def render_step(conn, job_id: str, step):
    conn.execute('UPDATE "RenderJob" SET step=%s, "lockedAt"=now() WHERE id=%s', (step, job_id))


def render_done(conn, job, *, url, key, thumb_url, duration, report=None):
    with conn.transaction():
        conn.execute("""UPDATE "RenderJob" SET status='done', progress=1, "outputUrl"=%s, "outputKey"=%s,
                        "thumbUrl"=%s, duration=%s, report=%s, error=NULL, step=NULL, "finishedAt"=now() WHERE id=%s""",
                     (url, key, thumb_url, duration, Jsonb(report) if report is not None else None, job["id"]))
        conn.execute("""UPDATE "Project" SET status='rendered', "thumbnailUrl"=COALESCE(%s, "thumbnailUrl"),
                        "updatedAt"=now() WHERE id=%s AND status IN ('ready','rendered')""",
                     (thumb_url, job["projectId"]))


def render_failed(conn, job, error: str):
    final = job["attempts"] >= 3 or "ffmpeg failed" in error or "insert" in error
    conn.execute("""UPDATE "RenderJob" SET status=%s, error=%s, step=NULL, "finishedAt"=now() WHERE id=%s""",
                 ("failed" if final else "queued", error[:4000], job["id"]))


# ------------------------------------------------------------------ inserts (worker/inserts.py, InsertJob)

def claim_insert(conn):
    return conn.execute(f"""
        UPDATE "InsertJob" SET status='processing', "lockedAt"=now(), "startedAt"=now(), attempts=attempts+1,
               progress=0, note=NULL
        WHERE id = (
          SELECT id FROM "InsertJob"
          WHERE (status='queued' OR (status='processing' AND "lockedAt" < now() - {STALE})) AND attempts < 3
          ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *""").fetchone()


def insert_progress(conn, insert_id: str, progress: float):
    conn.execute('UPDATE "InsertJob" SET progress=%s, "lockedAt"=now() WHERE id=%s', (progress, insert_id))


def insert_done(conn, insert_id: str, url: str, front_url):
    conn.execute("""UPDATE "InsertJob" SET status='done', progress=1, "outputUrl"=%s, "frontUrl"=%s, error=NULL, note=NULL,
                    "finishedAt"=now() WHERE id=%s""", (url, front_url, insert_id))


def insert_failed(conn, job, error: str):
    final = job["attempts"] >= 3 or "no reels" in error or "unknown insert" in error
    conn.execute("""UPDATE "InsertJob" SET status=%s, error=%s, "finishedAt"=now() WHERE id=%s""",
                 ("failed" if final else "queued", error[:2000], job["id"]))


def note_queued_inserts(conn, note):
    conn.execute("""UPDATE "InsertJob" SET note=%s WHERE status='queued' AND note IS DISTINCT FROM %s""", (note, note))


def inserts_by_hash(conn, project_id: str, hashes):
    rows = conn.execute("""SELECT * FROM "InsertJob" WHERE "projectId"=%s AND hash = ANY(%s)""",
                        (project_id, list(hashes))).fetchall()
    return {r["hash"]: r for r in rows}


def queue_insert(conn, project_id: str, user_id: str, h: str, kind: str, spec):
    conn.execute("""INSERT INTO "InsertJob" (id, "projectId", "userId", hash, kind, spec, status, progress, attempts, "createdAt")
                    VALUES (%s, %s, %s, %s, %s, %s, 'queued', 0, 0, now())
                    ON CONFLICT ("projectId", hash) DO UPDATE SET status='queued', attempts=0, error=NULL
                    WHERE "InsertJob".status='failed'""",
                 ("ins" + h[:20] + os.urandom(3).hex(), project_id, user_id, h, kind, Jsonb(spec)))
