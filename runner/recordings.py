"""
Download Browserbase session recordings and upload to Supabase Storage.
"""
import os
import json
import asyncio
import time
from typing import Optional

import httpx


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
        print(f"[RECORDING] Skipping — api_key={'present' if bb_api_key else 'MISSING'} session_id={session_id or 'MISSING'}")
        return None

    t0 = time.time()
    print(f"[RECORDING] save_session_recording — session={session_id} template={template_name!r}")
    print(f"[RECORDING]   waiting 5s for recording to finalize...")

    try:
        await asyncio.sleep(5)

        url = f"https://api.browserbase.com/v1/sessions/{session_id}/recording"
        print(f"[RECORDING]   fetching recording from Browserbase API...")
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
            print(f"[RECORDING]   Browserbase API response: status={response.status_code} ({fetch_elapsed:.1f}s)")

            if response.status_code != 200:
                print(f"[RECORDING]   WARNING: non-200 status — body preview: {response.text[:300]}")
                return None

            recording_data = response.json()

        if not recording_data:
            print("[RECORDING]   WARNING: empty recording data from Browserbase")
            return None

        data_size = len(json.dumps(recording_data))
        print(f"[RECORDING]   recording data received: {data_size} bytes")

        safe_name = template_name.replace(" ", "_").replace("/", "_")[:50]
        file_path = f"{test_run_id}/{safe_name}_{session_id}.json"
        recording_bytes = json.dumps(recording_data).encode("utf-8")

        print(f"[RECORDING]   uploading to Supabase Storage: test-recordings/{file_path}")
        upload_t0 = time.time()
        supabase.storage.from_("test-recordings").upload(
            path=file_path,
            file=recording_bytes,
            file_options={"content-type": "application/json"},
        )

        supabase_url = os.environ.get("SUPABASE_URL", "")
        public_url = f"{supabase_url}/storage/v1/object/public/test-recordings/{file_path}"

        total_elapsed = time.time() - t0
        print(f"[RECORDING]   upload complete ({time.time() - upload_t0:.1f}s)")
        print(f"[RECORDING]   public_url = {public_url}")
        print(f"[RECORDING] save_session_recording — done ({total_elapsed:.1f}s)")
        return public_url

    except Exception as e:
        total_elapsed = time.time() - t0
        print(f"[RECORDING] ERROR: Failed after {total_elapsed:.1f}s — {type(e).__name__}: {e}")
        return None
