import { NextResponse, type NextRequest } from "next/server";

/**
 * A sign-in link is CONFIRMED before it is redeemed.
 *
 * WHY GET DOES NOT SIGN ANYBODY IN. It used to, and that was two defects at
 * once. A GET that mints a session is a login-CSRF primitive: an attacker with
 * a pilot account requests a link for their OWN address and puts the URL where
 * a victim will follow it, and the victim's browser silently stores a session
 * for the attacker's organization — anything the victim then uploads lands in
 * the attacker's tenant, with the attacker's own audit trail recording it as
 * their work. Nothing in the token binds the browser that asked for the link to
 * the browser that presents it, and nothing can: opening a link on a second
 * device is the point of a magic link.
 *
 * The same GET also let a link be spent by something that was never a person.
 * Mail scanners, link-preview bots and antivirus proxies follow URLs in email;
 * every one of those would consume a single-use link before the recipient
 * clicked it, and the reader would be told their link did not work.
 *
 * So GET renders a page with a button, and only the POST redeems. That is one
 * extra click for the reader and it removes both: a top-level navigation
 * cannot redeem, and neither can a prefetch.
 *
 * The redemption itself lives in `confirm/route.ts` — a separate module,
 * because a route file may export a GET and a POST but the POST here would be
 * reachable cross-site from a form, and the confirm route can require the token
 * in the body rather than in a URL an attacker can hand out.
 */
export function GET(request: NextRequest): NextResponse {
  const token = request.nextUrl.searchParams.get("token");

  // Nothing is validated here. Telling somebody their link is malformed before
  // they confirm would answer "is this a real token?" at a lower cost than
  // redeeming it, and every failure has to look the same anyway.
  const safeToken = token === null ? "" : token;

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="origin">
<title>Confirm sign-in — Dasher</title>
<style>
  body { margin:0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         display:flex; min-height:100dvh; align-items:center; justify-content:center;
         background:#f6f5f1; color:#1a2420; }
  main { max-width:34rem; padding:2rem; background:#fff; border:1px solid #dcdad2;
         border-radius:12px; }
  h1 { margin:0 0 .75rem; font-size:1.35rem; }
  p { margin:0 0 1rem; color:#5a625d; }
  button { font:inherit; padding:.6rem 1.1rem; border:0; border-radius:8px;
           background:#1f6f4f; color:#fff; cursor:pointer; }
</style>
</head>
<body>
<main>
  <h1>Sign in to Dasher</h1>
  <p>This link signs you in and can only be used once. Confirm that you asked
     for it — if it arrived unexpectedly, close this page instead.</p>
  <form method="post" action="/sign-in/confirm">
    <input type="hidden" name="token" value="${escapeHtml(safeToken)}">
    <button type="submit">Sign me in</button>
  </form>
</main>
</body>
</html>`;

  return new NextResponse(page, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The token is in this page's form. Nothing should keep a copy.
      "cache-control": "no-store, no-cache, must-revalidate",
      // `origin`, not `no-referrer`. Measured: under `no-referrer` a browser
      // sends `Origin: null` even on a same-origin form post, which would make
      // the confirm route's origin check reject the legitimate flow. `origin`
      // sends a real Origin and a Referer that is just the origin — so the
      // token in this page's URL still never leaves it.
      "referrer-policy": "origin",
    },
  });
}

/**
 * The token is echoed into an attribute, so it is escaped.
 *
 * It is a base64url string when it is genuine, but the value here is whatever
 * the URL carried and is never validated before this point — deliberately, so
 * that a malformed token is not answered differently from a wrong one.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
