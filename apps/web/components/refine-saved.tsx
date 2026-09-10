"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { refineSavedDashboard } from "@/app/actions";
import { REFINEMENT_MAX_LENGTH } from "@/app/planning";

/**
 * Changing a saved dashboard by asking.
 *
 * The page above this renders sealed bytes and never recompiles, which is what
 * makes a saved dashboard stable. This does not weaken that: a change produces
 * a successor version with its own sealed bytes, and the page then renders
 * those. Nothing is edited in place, so the version that was approved yesterday
 * is still exactly what it was.
 *
 * `refinable` is false for a dashboard saved before the reading behind it was
 * kept. The form is still shown, disabled, with the reason: a control that
 * silently disappears reads as a feature that was removed.
 */
export function RefineSaved({
  dashboardId,
  refinable,
  unavailableReason,
}: {
  dashboardId: string;
  refinable: boolean;
  unavailableReason?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);
  const [instruction, setInstruction] = useState("");

  return (
    <section aria-label="Change this dashboard" className="panel refine-saved">
      <h2>Change this dashboard</h2>
      {refinable ? (
        <p>
          Ask for a change and Dasher rebuilds it from the same file. The
          version you are looking at is kept.
        </p>
      ) : (
        <p className="refine-unavailable">{unavailableReason}</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!refinable || instruction.trim() === "") return;
          setError(undefined);
          const body = new FormData();
          body.set("dashboardId", dashboardId);
          body.set("instruction", instruction);
          startTransition(async () => {
            const result = await refineSavedDashboard(body);
            if (result.ok) {
              setInstruction("");
              // The page reads the head version, which has just moved.
              router.refresh();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        <label htmlFor="refine-saved-instruction">Change this dashboard</label>
        <textarea
          disabled={!refinable || pending}
          id="refine-saved-instruction"
          maxLength={REFINEMENT_MAX_LENGTH}
          name="instruction"
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="Exclude Travel. Switch to quarterly. Just the overview."
          rows={2}
          value={instruction}
        />
        <button
          disabled={!refinable || pending || instruction.trim() === ""}
          type="submit"
        >
          {pending ? "Rebuilding…" : "Apply change"}
        </button>
      </form>
      {error === undefined ? null : (
        <p className="request-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
