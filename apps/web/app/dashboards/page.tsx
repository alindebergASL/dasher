import {
  DashboardRepositoryError,
  withDashboardRepository,
} from "@dasher/control-plane";
import Link from "next/link";

import { getPool, isPersistenceConfigured } from "../database";
import { readSessionCredential } from "../session";

/**
 * Your dashboards: the way back to what an organization has already built,
 * without keeping every permalink.
 *
 * A LISTING, NOT A GALLERY. Identity only — title, when, and the link — read
 * through the same request context and row-level security as `/d/[id]`, so
 * the isolation story is one story. No search, no folders, no thumbnails:
 * those are features a listing can grow if finding things this way turns out
 * to be how people work, and dead weight if it does not.
 *
 * BOUNDED, RECENT, NEWEST FIRST. Fifty is not pagination infrastructure; it
 * is a page that refuses to become a full-table read. If an organization
 * outgrows it, that is the signal to build finding-things properly.
 *
 * The two no-session states are ordinary, not errors, exactly as they are for
 * saving: an app configured without a database still runs the fixture demo,
 * and a browser without a session has simply not been through sign-in.
 */

export const dynamic = "force-dynamic";

const LIST_LIMIT = 50;

export default async function YourDashboards() {
  if (!isPersistenceConfigured()) {
    return (
      <Shell>
        <p className="dashboard-list-empty">
          Saving is not configured in this environment, so there is nothing to
          list. Dashboards you build still render — they just have no durable
          home to come back to.
        </p>
      </Shell>
    );
  }

  const credential = await readSessionCredential();
  if (credential === undefined) {
    return (
      <Shell>
        <SignedOutNote />
      </Shell>
    );
  }

  let entries;
  try {
    entries = await withDashboardRepository(
      getPool(),
      credential,
      async (repository) => repository.listRecent(LIST_LIMIT),
    );
  } catch (error) {
    // A well-formed cookie naming no live session arrives as the repository's
    // `not_authenticated`. The same rule as /d/[id]: that must not read
    // differently from having no session at all, so the holder of a forged
    // token learns nothing from this page.
    if (isNotAuthenticated(error)) {
      return (
        <Shell>
          <SignedOutNote />
        </Shell>
      );
    }
    throw error;
  }

  if (entries.length === 0) {
    return (
      <Shell>
        <p className="dashboard-list-empty">
          Nothing saved yet. Ask for a dashboard on the{" "}
          <Link href="/">request page</Link> and it will appear here the moment
          it is saved.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <ul className="dashboard-list">
        {entries.map((entry) => (
          <li className="dashboard-list-item" key={entry.dashboardId}>
            <Link
              className="dashboard-list-link"
              href={`/d/${entry.dashboardId}`}
            >
              {entry.title}
            </Link>
            <time className="dashboard-list-time" dateTime={entry.createdAt}>
              {formatCreatedAt(entry.createdAt)}
            </time>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="dashboard-list-page">
      <header className="dashboard-list-header">
        <h1>Your dashboards</h1>
        <p>
          Most recent first. <Link href="/">Build another</Link>.
        </p>
      </header>
      {children}
    </main>
  );
}

/** Stable server-side formatting; the exact instant stays in `dateTime`. */
function formatCreatedAt(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(createdAt));
}

/**
 * The one sentence both signed-out branches render.
 *
 * A COMPONENT rather than two copies, because the two branches are "no cookie"
 * and "a well-formed cookie the seam refused", and the rule is that they must
 * not read differently — otherwise somebody probing with a forged token learns
 * that it reached the seam and was rejected, where an absent cookie is simply
 * absent. Two copies is exactly how that guarantee was broken: adding a sign-in
 * link to the first branch and not the second left the comment below describing
 * a property the page no longer had.
 */
function SignedOutNote() {
  return (
    <p className="dashboard-list-empty">
      You are not signed in, so there are no saved dashboards to show.{" "}
      <a className="dashboard-list-link" href="/sign-in">
        Sign in
      </a>{" "}
      and anything you build will be waiting here.
    </p>
  );
}

function isNotAuthenticated(error: unknown): boolean {
  return (
    error instanceof DashboardRepositoryError &&
    error.code === "not_authenticated"
  );
}
