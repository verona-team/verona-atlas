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
import re
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
        # The recorder begins capturing before the page has rendered,
        # so every webm starts with a frozen blank/white viewport.
        # Detect that intro freeze and pass its end timestamp as
        # ``-ss`` to the transcode so the mp4 starts at the loaded UI:
        # the chat-side still frame is meaningful and users don't sit
        # through dead air when they hit play.
        trim_s = await _detect_intro_trim_s(webm_path)
        if trim_s and trim_s > 0:
            test_log(
                "debug",
                "recording_intro_trim",
                test_run_id=test_run_id,
                template_name=template_name,
                trim_s=round(trim_s, 3),
            )

        # ``-preset veryfast`` keeps wall-clock low without ballooning
        # file size; ``-pix_fmt yuv420p`` is required for QuickTime /
        # iOS Safari compatibility; ``-movflags +faststart`` moves the
        # MP4 ``moov`` atom to the front so HTML5 ``<video>`` can begin
        # playback before the file fully downloads (huge UX win for
        # long recordings).
        transcode_t0 = time.time()
        # ``-ss`` after ``-i`` so the seek is frame-accurate — we
        # re-encode anyway, so the speed cost vs. pre-input ``-ss`` is
        # small and worth the precision.
        ffmpeg_args = ["ffmpeg", "-y", "-i", webm_path]
        if trim_s and trim_s > 0:
            ffmpeg_args += ["-ss", f"{trim_s:.3f}"]
        ffmpeg_args += [
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-an",
            mp4_path,
        ]
        proc = await asyncio.create_subprocess_exec(
            *ffmpeg_args,
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


# Cap on how much intro we'll chop off. A recording where the page
# never loads would otherwise have its entire content trimmed away.
_MAX_INTRO_TRIM_S = 5.0

# Minimum freeze duration that counts as an intro freeze. The boot-up
# blank lasts on the order of seconds, so anything shorter than this
# is probably ordinary frame-to-frame stillness, not a stalled page.
_MIN_INTRO_FREEZE_S = 0.3

# How tolerant we are of pixel noise when deciding two frames are
# "the same". Tighter than freezedetect's default (0.001) because
# the blank viewport really is flat — a higher threshold risks
# matching genuinely static UI as a freeze.
_FREEZE_NOISE = 0.003


async def _detect_intro_trim_s(webm_path: str) -> Optional[float]:
    """Probe the start of ``webm_path`` for a frozen blank-viewport
    intro and return the timestamp at which the freeze ends, capped at
    :data:`_MAX_INTRO_TRIM_S`.

    Returns ``None`` if the probe fails, no qualifying freeze is
    found, or the first freeze begins noticeably after t=0 (i.e. it's
    a mid-recording stall, not an intro). The caller should treat a
    ``None`` return as "don't trim, transcode the whole file".

    Implementation: we run ffmpeg with the ``freezedetect`` filter and
    parse its ``freeze_start`` / ``freeze_end`` log lines. Input is
    capped at slightly more than :data:`_MAX_INTRO_TRIM_S` so the
    probe doesn't have to decode the whole recording.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-hide_banner",
            "-t", f"{_MAX_INTRO_TRIM_S + 1:.1f}",
            "-i", webm_path,
            "-vf", f"freezedetect=n={_FREEZE_NOISE}:d={_MIN_INTRO_FREEZE_S}",
            "-map", "0:v:0",
            "-f", "null",
            "-",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
    except Exception:
        return None

    if proc.returncode != 0:
        return None

    text = (stderr or b"").decode("utf-8", errors="replace")
    starts = re.findall(r"freeze_start:\s*(\d+(?:\.\d+)?)", text)
    ends = re.findall(r"freeze_end:\s*(\d+(?:\.\d+)?)", text)
    if not starts or not ends:
        return None

    first_start = float(starts[0])
    first_end = float(ends[0])
    # A freeze that doesn't start at the very beginning is a
    # mid-recording stall (e.g. a long-running test step), not the
    # boot-up intro we want to chop.
    if first_start > 0.2:
        return None
    return min(first_end, _MAX_INTRO_TRIM_S)
