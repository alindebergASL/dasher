import {
  DashboardRepositoryError,
  withDashboardRepository,
} from "@dasher/control-plane";
import Link from "next/link";
import { revalidatePath } from "next/cache";

import { archiveDashboard } from "../actions";
import { getPool, isPersistenceConfigured } from "../database";
import { readSessionCredential } from "../session";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 50;

export default async function YourDashboards() {
  if (!isPersistenceConfigured()) {
    return (
      <Shell>
        <p className="dashboard-list-empty">
          Saving is not configured in this environment, so there is nothing to
          list. Dashboards you build still render; they just have no durable
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
          Nothing saved yet. Build a dashboard on the{" "}
          <Link href="/">request page</Link> while signed in and it will
          appear here.
        </p>
      </Shell>
    );
  }

  async function archive(formData: FormData): Promise<void> {
    "use server";
    await archiveDashboard(formData);
    revalidatePath("/dashboards");
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
            <form action={archive} className="dashboard-list-archive">
              <input name="dashboardId" type="hidden" value={entry.dashboardId} />
              <input
                name="revision"
                type="hidden"
                value={String(entry.lifecycleRevision)}
              />
              <button
                aria-label={`Archive ${entry.title}`}
                className="dashboard-list-archive-button"
                type="submit"
              >
                Archive
              </button>
            </form>
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
          Most recent first, shared with everyone in your organization.{" "}
          <Link href="/">Build another</Link>.
        </p>
      </header>
      {children}
    </main>
  );
}

function formatCreatedAt(createdAt: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(createdAt));
}

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
