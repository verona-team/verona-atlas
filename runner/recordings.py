"""
Download Browserbase session recordings and upload to Supabase Storage.
"""
import os
import json
import asyncio
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
        return None

    try:
        await asyncio.sleep(5)

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(
                f"https://api.browserbase.com/v1/sessions/{session_id}/recording",
                headers={
                    "x-bb-api-key": bb_api_key,
                    "Content-Type": "application/json",
                },
            )

            if response.status_code != 200:
                print(f"Warning: Browserbase recording fetch returned {response.status_code}")
                return None

            recording_data = response.json()

        if not recording_data:
            print("Warning: Empty recording data from Browserbase")
            return None

        safe_name = template_name.replace(" ", "_").replace("/", "_")[:50]
        file_path = f"{test_run_id}/{safe_name}_{session_id}.json"
        recording_bytes = json.dumps(recording_data).encode("utf-8")

        result = supabase.storage.from_("test-recordings").upload(
            path=file_path,
            file=recording_bytes,
            file_options={"content-type": "application/json"},
        )

        supabase_url = os.environ.get("SUPABASE_URL", "")
        public_url = f"{supabase_url}/storage/v1/object/public/test-recordings/{file_path}"

        print(f"Recording uploaded: {public_url}")
        return public_url

    except Exception as e:
        print(f"Warning: Failed to save recording for session {session_id}: {e}")
        return None
