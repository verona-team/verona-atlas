"""
Download Browserbase session recordings and upload to Supabase Storage.
"""
import os
import json
import asyncio
import time
from typing import Optional

import httpx

from runner.logging import test_log


async def save_session_recording(
    supabase,
    session_id: str,
    test_run_id: str,
    template_name: str,
) -> Optional[str]:
    """Fetch rrweb recording from Browserbase and upload to Supabase Storage.

    Returns the public URL of the uploaded recording, or None on failure.
    """
    bb_api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not bb_api_key or not session_id:
        test_log(
            "warn",
            "recording_skipped_missing_config",
            test_run_id=test_run_id,
            template_name=template_name,
            has_api_key=bool(bb_api_key),
            has_session_id=bool(session_id),
        )
        return None

    t0 = time.time()
    test_log(
        "info",
        "recording_save_begin",
        test_run_id=test_run_id,
        template_name=template_name,
        browserbase_session_id=session_id,
    )

    try:
        await asyncio.sleep(5)

        url = f"https://api.browserbase.com/v1/sessions/{session_id}/recording"
        fetch_t0 = time.time()

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(
                url,
                headers={
                    "x-bb-api-key": bb_api_key,
                    "Content-Type": "application/json",
                },
            )

            fetch_elapsed = time.time() - fetch_t0

            if response.status_code != 200:
                test_log(
                    "warn",
                    "recording_fetch_non_200",
                    test_run_id=test_run_id,
                    template_name=template_name,
                    browserbase_session_id=session_id,
                    status_code=response.status_code,
                    elapsed_s=round(fetch_elapsed, 3),
                    body_preview=response.text[:300],
                )
                return None

            recording_data = response.json()

            test_log(
                "debug",
                "recording_fetch_ok",
                test_run_id=test_run_id,
                browserbase_session_id=session_id,
                elapsed_s=round(fetch_elapsed, 3),
            )

        if not recording_data:
            test_log(
                "warn",
                "recording_empty_data",
                test_run_id=test_run_id,
                browserbase_session_id=session_id,
            )
            return None

        data_size = len(json.dumps(recording_data))

        safe_name = template_name.replace(" ", "_").replace("/", "_")[:50]
        file_path = f"{test_run_id}/{safe_name}_{session_id}.json"
        recording_bytes = json.dumps(recording_data).encode("utf-8")

        upload_t0 = time.time()
        test_log(
            "debug",
            "recording_upload_begin",
            test_run_id=test_run_id,
            file_path=file_path,
            bytes=data_size,
        )
        supabase.storage.from_("test-recordings").upload(
            path=file_path,
            file=recording_bytes,
            file_options={"content-type": "application/json"},
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
        return None
