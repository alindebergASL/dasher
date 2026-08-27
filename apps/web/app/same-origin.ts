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
