import type { NextRequest } from "next/server";

import { publicOrigin } from "./mailer";

/**
 * Is this request from our own page, or from somebody else's?
 *
 * WHY THIS IS ITS OWN MODULE. It was written inline in `/sign-in/confirm` and
 * not applied to `/sign-out`, in the same commit — so one state-changing POST
 * was protected and the other was not, while the unprotected one's docstring
 * claimed POST-only was sufficient. Sharing the function makes "which routes
 * check this" answerable by grep instead of by memory.
 *
 * WHY POST-ONLY IS NOT ENOUGH, since that is the belief this exists to correct.
 * A cross-site auto-submitting form is a top-level navigation. An attacker
 * serves a page instead of a link and the victim's browser posts exactly as
 * their own would. `SameSite=lax` does not save it either: it governs whether a
 * cookie is SENT, not whether one may be SET, so a response can still plant or
 * clear a cookie on a cross-site POST.
 *
 * `Sec-Fetch-Site` FIRST, and it is the reliable one. The browser computes it,
 * will not send `same-origin` for a cross-site form, and — unlike `Origin` — it
 * is unaffected by the referrer policy and by what a reverse proxy does to the
 * Host header.
 *
 * `Origin` is the fallback for a browser too old to send `Sec-Fetch-Site`, and
 * it is compared against the CONFIGURED public origin rather than the request's
 * own, because behind a proxy the request's origin is the container's, not the
 * one the browser saw.
 *
 * A measured trap worth keeping written down: under
 * `Referrer-Policy: no-referrer` a browser sends `Origin: null` even on a
 * SAME-ORIGIN form post. An Origin-only check would therefore reject the
 * legitimate flow while looking correct in review. Pages that post here set
 * `referrer: origin`, which sends a real Origin and a Referer carrying no
 * query string.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";

  const origin = request.headers.get("origin");
  if (origin === null || origin === "null") return false;
  try {
    return origin === publicOrigin();
  } catch {
    // No configured origin means nothing to compare against, and guessing from
    // the request is what this check exists to avoid.
    return false;
  }
}

/**
 * Where to send a browser after a POST that changed something.
 *
 * `new URL("/", request.url)` is the obvious spelling and it is wrong on a
 * deployment. Next resolves `request.url` from the address it was told to
 * listen on, not from the `Host` the browser sent — so the image, which starts
 * with `--hostname 0.0.0.0 --port 3000`, redirected sign-in to
 * `http://0.0.0.0:3000/`. Measured against the built image behind a proxy:
 *
 *     HTTP/1.1 303 See Other
 *     location: http://0.0.0.0:3000/
 *     set-cookie: __Host-dasher_session=...; Secure; HttpOnly; SameSite=lax
 *
 * The session was real and the reader still landed on a browser error page,
 * signed in to a page they could not reach.
 *
 * The end-to-end suite cannot see this. It starts the same server with
 * `--hostname 127.0.0.1 --port 3100`, where `request.url` happens to be an
 * address the browser can reach, so every redirect resolves and every
 * assertion passes. The defect lives in the difference between how the suite
 * starts Next and how the Dockerfile does.
 *
 * `publicOrigin()` is the configured public address, already validated and
 * already required before a sign-in link can be raised at all. Falling back to
 * `request.url` keeps a local run working where the variable is unset — the
 * situation that hid this in the first place, kept deliberately rather than
 * turned into a crash.
 */
export function siteUrl(path: string, request: NextRequest): URL {
  try {
    return new URL(path, publicOrigin());
  } catch {
    return new URL(path, request.url);
  }
}
