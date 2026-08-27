import { readSessionCredential } from "@/app/session";

/**
 * The half of the header that depends on who is reading.
 *
 * WHAT THIS KNOWS, AND WHAT IT DOES NOT. It reads the cookie and nothing else —
 * no database round trip on every page render. So it answers "is this browser
 * presenting a session" rather than "is that session live", and those differ
 * for an expired or revoked one.
 *
 * That is deliberate rather than sloppy: a query here would put a database call
 * on every page including the ones that need no database at all, and it would
 * still be a moment out of date.
 *
 * WHERE IT VISIBLY DISAGREES WITH THE PAGE, stated because an earlier version
 * of this comment claimed they always agree. For a cookie the seam REFUSES —
 * expired, revoked, forged — this header offers "Sign out" while `/dashboards`
 * renders its signed-out note, because the page reaches the database and this
 * does not. That mismatch is the honest one to have: the reader does hold a
 * cookie, signing out is the action that clears it, and the alternative is a
 * header that says "Sign in" to somebody whose browser is still presenting a
 * credential.
 *
 * What the shared signal does buy is that the two never disagree about the
 * ABSENCE of a cookie, which is the case a probe could learn something from.
 */
export async function SessionNav() {
  const credential = await readSessionCredential();

  if (credential === undefined) {
    return <a href="/sign-in">Sign in</a>;
  }

  return (
    // A form, because signing out is a state change and a link is a GET that
    // any page or image tag could trigger on somebody's behalf.
    <form action="/sign-out" method="post">
      <button className="site-header-signout" type="submit">
        Sign out
      </button>
    </form>
  );
}
