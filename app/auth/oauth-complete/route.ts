import { type NextRequest, NextResponse } from 'next/server'

/**
 * Landing page loaded inside the OAuth popup after a successful integration
 * connect. Notifies the opener via postMessage and closes itself so the
 * parent UI can refresh immediately without waiting for the poll interval.
 */
export function GET(request: NextRequest) {
  const integration =
    request.nextUrl.searchParams.get('integration') ??
    (request.nextUrl.searchParams.get('github') ? 'github' : null) ??
    (request.nextUrl.searchParams.get('slack') ? 'slack' : null) ??
    'unknown'

  const safeIntegration = JSON.stringify(integration)
  const origin = request.nextUrl.origin
  const safeOrigin = JSON.stringify(origin)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Connected — you can close this window</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fafafa; color: #111;
    display: flex; align-items: center; justify-content: center;
  }
  main { text-align: center; padding: 24px; }
  .check {
    width: 40px; height: 40px; border-radius: 20px;
    background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74);
    margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 600;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 500; }
  p { color: #666; margin-top: 6px; font-size: 14px; }
</style>
</head>
<body>
<main>
  <div class="check">✓</div>
  <h1>Connected</h1>
  <p>You can close this window and return to Verona.</p>
</main>
<script>
  (function () {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { source: 'verona-oauth', integration: ${safeIntegration} },
          ${safeOrigin},
        );
      }
    } catch (e) { /* noop */ }
    setTimeout(function () {
      try { window.close(); } catch (e) { /* noop */ }
    }, 80);
  })();
</script>
</body>
</html>`

  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
