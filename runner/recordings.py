"""
Transcode the captured live-view webm to mp4 and upload it to Supabase
Storage so the chat UI can play it back in a native ``<video>``.

Why mp4 (not webm) on the public URL: Safari only plays VP9 webm on
Sonoma 14+, and Safari Mobile plays it nowhere. mp4/H.264 is the
lowest-common-denominator format every browser will play in a
``<video>`` tag without extra JS.
"""
import asyncio
import os
import time
from pathlib import Path
from typing import Optional

from runner.logging import test_log


async def save_session_recording(
    supabase,
    webm_path: str,
    test_run_id: str,
    template_name: str,
    session_id: str,
) -> Optional[str]:
    """Transcode ``webm_path`` to mp4 and upload to Supabase Storage.

    Returns the public URL of the uploaded mp4, or ``None`` on any
    failure. Caller must treat recording as best-effort.

    Cleans up both the source webm and the transcoded mp4 from local
    disk after a successful upload.
    """
    if not webm_path:
        test_log(
            "warn",
            "recording_skipped_no_webm",
            test_run_id=test_run_id,
            template_name=template_name,
        )
        return None

    if not Path(webm_path).exists():
        test_log(
            "warn",
            "recording_skipped_webm_missing",
            test_run_id=test_run_id,
            template_name=template_name,
            webm_path=webm_path,
        )
        return None

    t0 = time.time()
    test_log(
        "info",
        "recording_save_begin",
        test_run_id=test_run_id,
        template_name=template_name,
        browserbase_session_id=session_id,
        webm_path=webm_path,
        webm_bytes=Path(webm_path).stat().st_size,
    )

    mp4_path = str(Path(webm_path).with_suffix(".mp4"))

    try:
        # ``-preset veryfast`` keeps wall-clock low without ballooning
        # file size; ``-pix_fmt yuv420p`` is required for QuickTime /
        # iOS Safari compatibility; ``-movflags +faststart`` moves the
        # MP4 ``moov`` atom to the front so HTML5 ``<video>`` can begin
        # playback before the file fully downloads (huge UX win for
        # long recordings).
        transcode_t0 = time.time()
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-i", webm_path,
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an",
            mp4_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        transcode_elapsed = time.time() - transcode_t0

        if proc.returncode != 0:
            test_log(
                "warn",
                "recording_transcode_failed",
                test_run_id=test_run_id,
                template_name=template_name,
                browserbase_session_id=session_id,
                returncode=proc.returncode,
                stderr_tail=(stderr or b"").decode("utf-8", errors="replace")[-500:],
                elapsed_s=round(transcode_elapsed, 3),
            )
            _best_effort_unlink(webm_path)
            _best_effort_unlink(mp4_path)
            return None

        if not Path(mp4_path).exists():
            test_log(
                "warn",
                "recording_transcode_no_output",
                test_run_id=test_run_id,
                template_name=template_name,
                browserbase_session_id=session_id,
                elapsed_s=round(transcode_elapsed, 3),
            )
            _best_effort_unlink(webm_path)
            return None

        mp4_bytes = Path(mp4_path).stat().st_size
        test_log(
            "debug",
            "recording_transcode_ok",
            test_run_id=test_run_id,
            mp4_bytes=mp4_bytes,
            elapsed_s=round(transcode_elapsed, 3),
        )

        safe_name = template_name.replace(" ", "_").replace("/", "_")[:50]
        # ``session_id`` may be empty if the cloud browser failed
        # before the Browserbase session id was assigned. Fall back to
        # the test_run_id so paths stay unique.
        suffix = session_id or test_run_id
        file_path = f"{test_run_id}/{safe_name}_{suffix}.mp4"

        with open(mp4_path, "rb") as f:
            mp4_bytes_buf = f.read()

        upload_t0 = time.time()
        test_log(
            "debug",
            "recording_upload_begin",
            test_run_id=test_run_id,
            file_path=file_path,
            bytes=len(mp4_bytes_buf),
        )
        supabase.storage.from_("test-recordings").upload(
            path=file_path,
            file=mp4_bytes_buf,
            file_options={"content-type": "video/mp4"},
        )

        supabase_url = os.environ.get("SUPABASE_URL", "")
        public_url = f"{supabase_url}/storage/v1/object/public/test-recordings/{file_path}"

        total_elapsed = time.time() - t0
        test_log(
            "info",
            "recording_save_ok",
            test_run_id=test_run_id,
            template_name=template_name,
            browserbase_session_id=session_id,
            upload_elapsed_s=round(time.time() - upload_t0, 3),
            total_elapsed_s=round(total_elapsed, 3),
            public_url=public_url,
        )

        _best_effort_unlink(webm_path)
        _best_effort_unlink(mp4_path)
        return public_url

    except Exception as e:
        total_elapsed = time.time() - t0
        test_log(
            "error",
            "recording_save_failed",
            test_run_id=test_run_id,
            template_name=template_name,
            browserbase_session_id=session_id,
            total_elapsed_s=round(total_elapsed, 3),
            err_type=type(e).__name__,
            err=str(e),
        )
        _best_effort_unlink(webm_path)
        _best_effort_unlink(mp4_path)
        return None


def _best_effort_unlink(path: str) -> None:
    """Delete ``path`` if it exists; swallow any error."""
    try:
        Path(path).unlink(missing_ok=True)
    except Exception:
        pass
