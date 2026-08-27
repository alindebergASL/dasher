import { readSessionCredential } from "@/app/session";

/**
 * The half of the header that depends on who is reading.
 *
 * WHAT THIS KNOWS, AND WHAT IT DOES NOT. It reads the cookie and nothing else —
 * no database round trip on every page render. So it answers "is this browser
 * presenting a session" rather than "is that session live", and those differ
 * for an expired or revoked one.
 *
 * That is deliberate rather than sloppy, because the alternative is worse in
 * both directions: a query here would put a database call on every page
 * including the ones that need no database at all, and it would still be a
 * moment out of date. What makes it honest is that `readSessionCredential` is
 * the SAME signal `/dashboards` and `/d/[id]` already decide on, so the header
 * and the page always agree with each other. Signing out with a dead session is
 * a no-op that clears the cookie, which is exactly the right outcome.
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
