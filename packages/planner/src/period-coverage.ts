/**
 * Source-neutral period coverage analysis over canonical observations.
 *
 * This module deliberately proves less than it could guess. A comparison is
 * available only when consecutive prior and latest analysis periods contain
 * every expected observation at a regular supported frequency. A latest prefix
 * may be called partial only after a complete prior period establishes that
 * frequency; every irregular or ambiguous shape remains unknown.
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

/**
 * Proves coverage from canonical observations only. It never uses the current
 * date, a fixture name, source kind, row amount, or a forecast.
 */
export function analyzePeriodCoverage(
  analysisGrain: Grain,
  periods: readonly string[],
  observations: readonly PeriodObservation[],
  invalidPeriodCount: number,
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

  const observationGrain = inferObservationGrain(observations);
  if (observationGrain === undefined) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "The observed dates do not establish a regular daily, monthly, quarterly, or yearly frequency.",
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
  if (nextAnalysisPeriod(previousPeriod) !== latestPeriod) {
    return unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "The latest and prior observed periods are not consecutive analysis periods.",
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
    return {
      ...unknown(
        latestPeriod,
        observations,
        previousPeriod,
        `The prior period ${periodLabel(previousPeriod)} does not contain every expected ${adjective(observationGrain)} observation.`,
      ),
      observationGrain,
      expectedCount: latestExpected.length,
      priorObservedCount: previousObserved.length,
    };
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
      reason: `${periodLabel(latestPeriod)} and ${periodLabel(previousPeriod)} each contain every expected ${adjective(observationGrain)} observation, so current-vs-prior comparison is available.`,
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
      reason: `${periodLabel(latestPeriod)} has ${String(latestObserved.length)} of ${String(latestExpected.length)} expected ${adjective(observationGrain)} observations; observed dates run from ${latestObserved[0] as string} through ${latestObserved.at(-1) as string}, inside expected bounds ${fields.expectedStart as string} through ${fields.expectedEnd as string}. ${periodLabel(previousPeriod)} has all ${String(previousExpected.length)} expected observations. Current-vs-prior change is unavailable because the latest period is partial.`,
    };
  }

  return {
    ...unknown(
      latestPeriod,
      observations,
      previousPeriod,
      "The latest period does not contain a complete or contiguous prefix of the expected observations.",
    ),
    observationGrain,
    expectedCount: latestExpected.length,
    priorObservedCount: previousObserved.length,
  };
}
