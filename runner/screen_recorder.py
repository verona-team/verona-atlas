"""
Live-view screen recorder.

Spawns a second headless Chromium that loads Browserbase's debugger /
fullscreen URL for the current session, with Playwright's
``record_video_dir`` set so the entire viewport is captured to disk as
a webm. When the test completes we close the context (which flushes
the webm) and hand the file path off to ``runner.recordings`` for
transcoding + upload.

Lifecycle contract:
  recorder = LiveViewRecorder(...)
  await recorder.start()        # may raise; failure is non-fatal upstream
  ...                           # test runs
  webm = await recorder.stop()  # idempotent; safe to call multiple times
  ...                           # cloud browser still alive here
  cleanup_session(...)          # tear down the real browser

``stop()`` is idempotent and always flushes the webm before returning.
The runner relies on this so it can call it from both the success path
and from a finally without worrying about double-close.
"""
from pathlib import Path

from playwright.async_api import async_playwright

from runner.logging import test_log


class LiveViewRecorder:
    """Owns a headless Chromium that records ``live_view_url`` to a webm.

    One instance per template execution. Not reusable.
    """

    def __init__(
        self,
        live_view_url: str,
        output_dir: str,
        *,
        test_run_id: str,
        template_name: str,
        viewport_width: int = 1280,
        viewport_height: int = 720,
    ) -> None:
        self._live_view_url = live_view_url
        self._output_dir = output_dir
        self._test_run_id = test_run_id
        self._template_name = template_name
        self._viewport_width = viewport_width
        self._viewport_height = viewport_height

        self._pw = None
        self._browser = None
        self._context = None
        self._started = False
        self._stopped = False
        self._webm_path: str | None = None

    async def start(self) -> None:
        """Launch Chromium and navigate to the live-view URL.

        Raises on any launch / navigate failure. Caller is responsible
        for catching and treating recording as best-effort.
        """
        if self._started:
            return
        Path(self._output_dir).mkdir(parents=True, exist_ok=True)

        self._pw = await async_playwright().start()
        # ``--no-sandbox`` is required because Modal containers run as
        # root without user namespaces; ``--disable-dev-shm-usage``
        # avoids /dev/shm exhaustion in small container environments.
        self._browser = await self._pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._context = await self._browser.new_context(
            viewport={
                "width": self._viewport_width,
                "height": self._viewport_height,
            },
            record_video_dir=self._output_dir,
            record_video_size={
                "width": self._viewport_width,
                "height": self._viewport_height,
            },
        )
        page = await self._context.new_page()
        # ``domcontentloaded`` is enough — the live-view player establishes
        # its websocket on its own once the page boots. Waiting for
        # ``networkidle`` would hang forever because the player keeps a
        # persistent stream open.
        await page.goto(
            self._live_view_url,
            wait_until="domcontentloaded",
            timeout=15000,
        )
        self._started = True
        test_log(
            "info",
            "screen_recorder_started",
            test_run_id=self._test_run_id,
            template_name=self._template_name,
            viewport_width=self._viewport_width,
            viewport_height=self._viewport_height,
        )

    async def stop(self) -> str | None:
        """Close the recording context (flushes the webm) and return the
        path to the captured file, or ``None`` if recording never
        successfully started or no file was produced.

        Idempotent: subsequent calls return the cached path.
        """
        if self._stopped:
            return self._webm_path
        self._stopped = True

        if not self._started:
            await self._teardown_partial()
            return None

        try:
            # ``context.close()`` is what writes the .webm to disk —
            # Playwright streams frames during the run but doesn't
            # finalize the file until the context closes.
            await self._context.close()
        except Exception as e:
            test_log(
                "warn",
                "screen_recorder_context_close_failed",
                test_run_id=self._test_run_id,
                template_name=self._template_name,
                err_type=type(e).__name__,
                err=str(e),
            )

        try:
            files = sorted(Path(self._output_dir).glob("*.webm"))
            self._webm_path = files[0].as_posix() if files else None
        except Exception as e:
            test_log(
                "warn",
                "screen_recorder_glob_failed",
                test_run_id=self._test_run_id,
                err_type=type(e).__name__,
                err=str(e),
            )
            self._webm_path = None

        await self._teardown_partial()

        test_log(
            "info",
            "screen_recorder_stopped",
            test_run_id=self._test_run_id,
            template_name=self._template_name,
            has_webm=bool(self._webm_path),
            webm_path=self._webm_path,
        )
        return self._webm_path

    async def _teardown_partial(self) -> None:
        """Close browser + Playwright instance. Best-effort; never raises."""
        if self._browser is not None:
            try:
                await self._browser.close()
            except Exception as e:
                test_log(
                    "warn",
                    "screen_recorder_browser_close_failed",
                    test_run_id=self._test_run_id,
                    err_type=type(e).__name__,
                    err=str(e),
                )
            finally:
                self._browser = None
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception as e:
                test_log(
                    "warn",
                    "screen_recorder_playwright_stop_failed",
                    test_run_id=self._test_run_id,
                    err_type=type(e).__name__,
                    err=str(e),
                )
            finally:
                self._pw = None
        self._context = None
