/**
 * Source-neutral period coverage analysis over canonical observations.
 *
 * This module deliberately proves less than it could guess, but it must prove
 * what it can, because withholding an answer the data supports is its own kind
 * of wrong. Two independent things can establish that a period is finished:
 *
 * 1. The grid. When observations fall on a regular daily, monthly, quarterly or
 *    yearly frequency, a period is complete when it holds every observation
 *    that frequency expects. This is the shape a budget or metrics export
 *    takes, and a gap inside the latest period is real evidence of truncation.
 *
 * 2. The calendar. Most data is not a grid — transactions, tickets, readings
 *    and signups arrive when they arrive, and no frequency can be inferred from
 *    them at all. For these, completeness is a fact about time rather than
 *    density: a period whose last day fell before the source was retrieved had
 *    already finished, so the export had the whole of it available. A quiet
 *    week does not make a month incomplete.
 *
 * An earlier version had only the grid, so every irregular shape was
 * "unknown" and the change went unreported for the most ordinary data there
 * is. What remains unknown now is genuinely ambiguous: non-consecutive
 * periods, unreadable values, or a latest period still running with no
 * retrieval time to date it against.
 */
import {
  periodGrain,
  periodLabel,
  periodStartIso,
  type Grain,
} from "./workbook";

export type ObservationGrain = "day" | Grain;
export type PeriodCompleteness = "complete" | "incomplete" | "unknown";
export type ComparisonDisposition =
  | "available"
  | "unavailable-partial"
  | "unavailable-unknown"
  | "unavailable-no-prior";

export interface PeriodObservation {
  readonly period: string;
  /** Canonical UTC calendar date, `YYYY-MM-DD`. */
  readonly at: string;
  /** Present when the source value explicitly names its own period grain. */
  readonly grain?: Grain;
}

export interface PeriodCoverage {
  readonly status: PeriodCompleteness;
  readonly latestPeriod?: string;
  readonly latestLabel?: string;
  readonly observedStart?: string;
  readonly observedEnd?: string;
  readonly expectedStart?: string;
  readonly expectedEnd?: string;
  readonly observationGrain?: ObservationGrain;
  readonly observedCount: number;
  readonly expectedCount?: number;
  readonly priorPeriod?: string;
  readonly priorObservedCount?: number;
  /** Calendar day the source was retrieved, when the calendar path was used. */
  readonly vantageDay?: string;
  /** Whole days of the latest period that had passed at `vantageDay`. */
  readonly elapsedDays?: number;
  /** Days the latest period spans in total. */
  readonly periodDays?: number;
  readonly comparisonDisposition: ComparisonDisposition;
  readonly reason: string;
}

const OBSERVATION_RANK: Readonly<Record<ObservationGrain, number>> = {
  year: 0,
  quarter: 1,
  month: 2,
  day: 3,
};

function date(isoDay: string): Date {
  return new Date(`${isoDay}T00:00:00.000Z`);
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addObservation(value: string, grain: ObservationGrain): string {
  const next = date(value);
  switch (grain) {
    case "day":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "month":
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      break;
    case "quarter":
      next.setUTCMonth(next.getUTCMonth() + 3, 1);
      break;
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + 1, 0, 1);
      break;
  }
  return isoDay(next);
}

function expectedEnd(period: string): string {
  const start = date(periodStartIso(period).slice(0, 10));
  switch (periodGrain(period)) {
    case "month":
      start.setUTCMonth(start.getUTCMonth() + 1, 0);
      break;
    case "quarter":
      start.setUTCMonth(start.getUTCMonth() + 3, 0);
      break;
    case "year":
      start.setUTCFullYear(start.getUTCFullYear() + 1, 0, 0);
      break;
  }
  return isoDay(start);
}

function expectedObservations(
  period: string,
  grain: ObservationGrain,
): string[] {
  const start = periodStartIso(period).slice(0, 10);
  const end = expectedEnd(period);
  const observations: string[] = [];
  for (
    let cursor = start;
    cursor <= end;
    cursor = addObservation(cursor, grain)
  ) {
    observations.push(cursor);
  }
  return observations;
}

function nextAnalysisPeriod(period: string): string {
  const start = date(periodStartIso(period).slice(0, 10));
  switch (periodGrain(period)) {
    case "month":
      start.setUTCMonth(start.getUTCMonth() + 1, 1);
      return isoDay(start).slice(0, 7);
    case "quarter": {
      start.setUTCMonth(start.getUTCMonth() + 3, 1);
      const year = start.getUTCFullYear();
      const quarter = Math.floor(start.getUTCMonth() / 3) + 1;
      return `${String(year)}-Q${String(quarter)}`;
    }
    case "year":
      return String(start.getUTCFullYear() + 1);
  }
}

function regularAt(dates: readonly string[], grain: ObservationGrain): boolean {
  if (dates.length < 2) return false;
  return dates.slice(1).every((value, index) => {
    const previous = dates[index] as string;
    return value === addObservation(previous, grain);
  });
}

function atBoundary(value: string, grain: ObservationGrain): boolean {
  const parsed = date(value);
  if (grain === "day") return true;
  if (parsed.getUTCDate() !== 1) return false;
  if (grain === "month") return true;
  if (grain === "quarter") return parsed.getUTCMonth() % 3 === 0;
  return parsed.getUTCMonth() === 0;
}

function inferObservationGrain(
  observations: readonly PeriodObservation[],
): ObservationGrain | undefined {
  const explicit = [
    ...new Set(
      observations.flatMap((observation) =>
        observation.grain === undefined ? [] : [observation.grain],
      ),
    ),
  ];
  if (explicit.length > 0 && explicit.length !== 1) return undefined;
  if (
    explicit.length === 1 &&
    observations.some((observation) => observation.grain === undefined)
  ) {
    return undefined;
  }

  const dates = [
    ...new Set(observations.map((observation) => observation.at)),
  ].sort();
  const candidates: readonly ObservationGrain[] =
    explicit.length === 1
      ? [explicit[0] as Grain]
      : ["day", "month", "quarter", "year"];
  return candidates.find(
    (grain) =>
      dates.every((value) => atBoundary(value, grain)) &&
      regularAt(dates, grain),
  );
}

function uniqueDates(
  observations: readonly PeriodObservation[],
  period: string | undefined,
): string[] {
  if (period === undefined) return [];
  return [
    ...new Set(
      observations
        .filter((observation) => observation.period === period)
        .map((observation) => observation.at),
    ),
  ].sort();
}

function periodFields(
  latestPeriod: string | undefined,
  observations: readonly PeriodObservation[],
): Pick<
  PeriodCoverage,
  | "latestPeriod"
  | "latestLabel"
  | "observedStart"
  | "observedEnd"
  | "expectedStart"
  | "expectedEnd"
  | "observedCount"
> {
  if (latestPeriod === undefined) return { observedCount: 0 };
  const observed = uniqueDates(observations, latestPeriod);
  return {
    latestPeriod,
    latestLabel: periodLabel(latestPeriod),
    ...(observed[0] === undefined ? {} : { observedStart: observed[0] }),
    ...(observed.at(-1) === undefined ? {} : { observedEnd: observed.at(-1) }),
    expectedStart: periodStartIso(latestPeriod).slice(0, 10),
    expectedEnd: expectedEnd(latestPeriod),
    observedCount: observed.length,
  };
}

function sameDates(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function adjective(grain: ObservationGrain): string {
  switch (grain) {
    case "day":
      return "daily";
    case "month":
      return "monthly";
    case "quarter":
      return "quarterly";
    case "year":
      return "yearly";
  }
}

function comparisonLabel(grain: Grain): string {
  switch (grain) {
    case "month":
      return "month-over-month";
    case "quarter":
      return "quarter-over-quarter";
    case "year":
      return "year-over-year";
  }
}

function unknown(
  latestPeriod: string | undefined,
  observations: readonly PeriodObservation[],
  previousPeriod: string | undefined,
  reason: string,
): PeriodCoverage {
  return {
    status: "unknown",
    ...periodFields(latestPeriod, observations),
    ...(previousPeriod === undefined ? {} : { priorPeriod: previousPeriod }),
    comparisonDisposition:
      previousPeriod === undefined
        ? "unavailable-no-prior"
        : "unavailable-unknown",
    reason,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function daysBetween(from: string, to: string): number {
  return Math.round((date(to).getTime() - date(from).getTime()) / DAY_MS);
}

/**
 * Whole days of `period` that had passed at `vantageDay`, clamped to the
 * period. The vantage day itself is still running, so it does not count.
 */
function elapsedWithin(period: string, vantageDay: string): number {
  const start = periodStartIso(period).slice(0, 10);
  const end = expectedEnd(period);
  if (vantageDay <= start) return 0;
  const last = vantageDay > end ? end : vantageDay;
  return daysBetween(start, last);
}

/**
 * Proves coverage from the calendar rather than from observation density, for
 * the data that has no regular frequency to count against. A period whose last
 * day fell before the source was retrieved had finished, so the export saw all
 * of it; one still running had not.
 */
function calendarCoverage(
  analysisGrain: Grain,
  latestPeriod: string,
  previousPeriod: string,
  observations: readonly PeriodObservation[],
  vantage: string | undefined,
  /** Set when a frequency was inferable but the observations did not fill it. */
  unfitGrain?: ObservationGrain,
): PeriodCoverage {
  // Why the grid could not answer, stated accurately: there was no frequency
  // to count against, or there was one and the data does not keep to it.
  const gridSays =
    unfitGrain === undefined
      ? "The dates establish no regular frequency"
      : `The dates suggest a ${adjective(unfitGrain)} frequency but do not keep to it`;
  const fields = periodFields(latestPeriod, observations);
  const previousObserved = uniqueDates(observations, previousPeriod);
  const shared = {
    ...fields,
    priorPeriod: previousPeriod,
    priorObservedCount: previousObserved.length,
  };
  if (vantage === undefined) {
    return {
      status: "unknown",
      ...shared,
      comparisonDisposition: "unavailable-unknown",
      reason: `${gridSays}, and no source retrieval time is available to tell whether the latest period has finished.`,
    };
  }
  const vantageDay = vantage.slice(0, 10);
  const periodEnd = expectedEnd(latestPeriod);
  // Inclusive of both ends: September spans 30 days, not the 29 that separate
  // the first from the last.
  const periodDays =
    daysBetween(periodStartIso(latestPeriod).slice(0, 10), periodEnd) + 1;
  if (periodEnd < vantageDay) {
    return {
      status: "complete",
      ...shared,
      vantageDay,
      periodDays,
      elapsedDays: periodDays,
      comparisonDisposition: "available",
      reason: `${periodLabel(latestPeriod)} ended on ${periodEnd}, before the source was retrieved on ${vantageDay}, so the whole period was available to the export; ${periodLabel(previousPeriod)} is the period before it. ${gridSays}, so coverage rests on the calendar rather than on how many observations each period holds, and ${comparisonLabel(analysisGrain)} comparison is available.`,
    };
  }
  const elapsedDays = elapsedWithin(latestPeriod, vantageDay);
  const observedEnd = fields.observedEnd;
  return {
    status: "incomplete",
    ...shared,
    vantageDay,
    periodDays,
    elapsedDays,
    comparisonDisposition: "unavailable-partial",
    reason: `${periodLabel(latestPeriod)} runs to ${periodEnd} but the source was retrieved on ${vantageDay}, with only ${String(elapsedDays)} of its ${String(periodDays)} days elapsed${observedEnd === undefined ? "" : `, and observations stopping at ${observedEnd}`}. ${periodLabel(previousPeriod)} had finished. The ${comparisonLabel(analysisGrain)} change is unavailable because the latest period is still running.`,
  };
}

/**
 * Proves coverage from canonical observations and the source's own retrieval
 * time. It never uses the current date, a fixture name, source kind, row
 * amount, or a forecast.
 */
export function analyzePeriodCoverage(
  analysisGrain: Grain,
  periods: readonly string[],
  observations: readonly PeriodObservation[],
  invalidPeriodCount: number,
  unreadableAmountPeriods: ReadonlySet<string> = new Set(),
  vantage?: string,
): PeriodCoverage {
  const latestPeriod = periods.at(-1);
  const previousPeriod = periods.length >= 2 ? periods.at(-2) : undefined;

  if (latestPeriod === undefined) {
    return {
      status: "unknown",
      observedCount: 0,
      comparisonDisposition: "unavailable-no-prior",
      reason: "There is no period column in this dataset.",
    };
  }
  if (previousPeriod === undefined) {
    return unknown(
      latestPeriod,
      observations,
      undefined,
      "There is no prior analysis period in this dataset to establish comparable coverage.",
    );
  }
  if (invalidPeriodCount > 0) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "At least one selected row has a missing or invalid period value.",
    );
  }
  if (
    unreadableAmountPeriods.has(latestPeriod) ||
    unreadableAmountPeriods.has(previousPeriod)
  ) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "At least one selected row in the latest or prior analysis period has an unreadable amount value.",
    );
  }

  // Consecutiveness is a fact about the two period labels alone, so it is
  // settled before either completeness path, both of which assume it.
  if (nextAnalysisPeriod(previousPeriod) !== latestPeriod) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "The latest and prior observed periods are not consecutive analysis periods.",
    );
  }

  const observationGrain = inferObservationGrain(observations);
  if (observationGrain === undefined) {
    return calendarCoverage(
      analysisGrain,
      latestPeriod,
      previousPeriod,
      observations,
      vantage,
    );
  }
  if (OBSERVATION_RANK[observationGrain] < OBSERVATION_RANK[analysisGrain]) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "The observed frequency is coarser than the requested analysis period.",
    );
  }

  const latestObserved = uniqueDates(observations, latestPeriod);
  const previousObserved = uniqueDates(observations, previousPeriod);
  const latestExpected = expectedObservations(latestPeriod, observationGrain);
  const previousExpected = expectedObservations(
    previousPeriod,
    observationGrain,
  );
  if (!sameDates(previousObserved, previousExpected)) {
    // A frequency was inferable but the prior period does not hold every
    // observation it implies, so the grid does not describe this data. The
    // calendar can still settle it.
    return calendarCoverage(
      analysisGrain,
      latestPeriod,
      previousPeriod,
      observations,
      vantage,
      observationGrain,
    );
  }

  const fields = periodFields(latestPeriod, observations);
  const shared = {
    ...fields,
    observationGrain,
    expectedCount: latestExpected.length,
    priorPeriod: previousPeriod,
    priorObservedCount: previousObserved.length,
  };
  if (sameDates(latestObserved, latestExpected)) {
    return {
      status: "complete",
      ...shared,
      comparisonDisposition: "available",
      reason: `${periodLabel(latestPeriod)} and ${periodLabel(previousPeriod)} each contain every expected ${adjective(observationGrain)} observation, so ${comparisonLabel(analysisGrain)} comparison is available.`,
    };
  }

  const isPrefix = latestObserved.every(
    (value, index) => value === latestExpected[index],
  );
  if (
    latestObserved.length > 0 &&
    latestObserved.length < latestExpected.length &&
    isPrefix
  ) {
    return {
      status: "incomplete",
      ...shared,
      comparisonDisposition: "unavailable-partial",
      reason: `${periodLabel(latestPeriod)} has ${String(latestObserved.length)} of ${String(latestExpected.length)} expected ${adjective(observationGrain)} observations; observed dates run from ${latestObserved[0] as string} through ${latestObserved.at(-1) as string}, inside expected bounds ${fields.expectedStart as string} through ${fields.expectedEnd as string}. ${periodLabel(previousPeriod)} has all ${String(previousExpected.length)} expected observations. The ${comparisonLabel(analysisGrain)} change is unavailable because the latest period is partial.`,
    };
  }

  // Gapped rather than truncated: the grid cannot say which observations are
  // missing on purpose, so defer to the calendar.
  return calendarCoverage(
    analysisGrain,
    latestPeriod,
    previousPeriod,
    observations,
    vantage,
    observationGrain,
  );
}
