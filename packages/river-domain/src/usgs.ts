import { z } from "zod";

import type { Series, Station } from "@dasher/station-domain";

export const USGS_PAYLOAD_MAX_BYTES = 5 * 1_024 * 1_024;
export const USGS_MAX_TOTAL_OBSERVATIONS = 20_000;

export const USGS_STRING_LIMITS = {
  siteName: 256,
  variableCode: 64,
  variableDescription: 512,
  unitCode: 32,
  observationValue: 128,
  isoTimestamp: 64,
  note: 512,
} as const;

const SiteIdSchema = z.string().regex(/^\d{8,15}$/, "Invalid USGS site ID");
const UsgsTimestampSchema = z
  .string()
  .max(USGS_STRING_LIMITS.isoTimestamp)
  .datetime({ offset: true });

const ValueSchema = z.object({
  value: z.string().max(USGS_STRING_LIMITS.observationValue),
  dateTime: UsgsTimestampSchema,
});

const TimeSeriesSchema = z.object({
  sourceInfo: z.object({
    siteName: z.string().min(1).max(USGS_STRING_LIMITS.siteName),
    siteCode: z
      .array(z.object({ value: SiteIdSchema }))
      .min(1)
      .max(4, "Too many site codes in USGS time series"),
    geoLocation: z.object({
      geogLocation: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
    }),
  }),
  variable: z.object({
    variableCode: z
      .array(
        z.object({
          value: z.string().min(1).max(USGS_STRING_LIMITS.variableCode),
        }),
      )
      .min(1)
      .max(4, "Too many variable codes in USGS time series"),
    variableDescription: z
      .string()
      .min(1)
      .max(USGS_STRING_LIMITS.variableDescription),
    unit: z.object({
      unitCode: z.string().min(1).max(USGS_STRING_LIMITS.unitCode),
    }),
    noDataValue: z.number(),
  }),
  values: z
    .array(
      z.object({
        value: z
          .array(ValueSchema)
          .max(10_000, "Too many observations in USGS value group"),
      }),
    )
    .min(1)
    .max(4, "Too many value groups in USGS time series"),
});

/**
 * WHERE THE RETRIEVAL TIME LIVES, and why there are two answers.
 *
 * The live instantaneous-values service reports when it answered inside
 * `queryInfo.note[]`, as an entry titled `requestDT`. It does NOT emit a
 * `creationTime` field — which the first version of this parser required,
 * so it could not parse a single real USGS response. That was invisible
 * while the only payload it ever saw was a hand-authored fixture; wiring a
 * live source is what surfaced it.
 *
 * Both shapes are accepted because both are real inputs to this function:
 * `requestDT` is what the service sends, and `creationTime` is what the
 * committed development fixture carries (deliberately degraded data that
 * the freshness tests depend on, which a verbatim capture cannot provide).
 * A payload with NEITHER is rejected rather than defaulted, because this
 * timestamp is load-bearing twice over: it becomes every station's
 * `retrievedAt`, and it is the bound the future-observation check uses. A
 * parser that invented it would be inventing provenance.
 */
const QueryInfoSchema = z
  .object({
    creationTime: UsgsTimestampSchema.optional(),
    note: z
      .array(
        z.object({
          // Real notes carry filter descriptions, a request id, and a
          // provisional-data disclaimer, not just the timestamp — sizing this
          // to a timestamp rejected every live response.
          value: z.string().max(USGS_STRING_LIMITS.note),
          title: z.string().max(USGS_STRING_LIMITS.variableCode).optional(),
        }),
      )
      .max(16, "Too many notes in USGS queryInfo")
      .optional(),
  })
  .transform((queryInfo, context) => {
    const requestDt = queryInfo.note?.find(
      (entry) => entry.title === "requestDT",
    )?.value;
    const retrievedAt = queryInfo.creationTime ?? requestDt;

    if (retrievedAt === undefined || Number.isNaN(Date.parse(retrievedAt))) {
      context.addIssue({
        code: "custom",
        message:
          "USGS queryInfo must carry a retrieval time, as creationTime or a requestDT note",
        path: ["creationTime"],
      });
      return z.NEVER;
    }

    return { retrievedAt };
  });

const ResponseSchema = z
  .object({
    value: z.object({
      queryInfo: QueryInfoSchema,
      timeSeries: z
        .array(TimeSeriesSchema)
        .min(1)
        .max(60, "Too many time series in USGS response"),
    }),
  })
  .superRefine((response, context) => {
    const creationTime = Date.parse(response.value.queryInfo.retrievedAt);

    for (const [
      seriesIndex,
      timeSeries,
    ] of response.value.timeSeries.entries()) {
      for (const [groupIndex, group] of timeSeries.values.entries()) {
        for (const [observationIndex, observation] of group.value.entries()) {
          if (Date.parse(observation.dateTime) > creationTime) {
            context.addIssue({
              code: "custom",
              message:
                "USGS observation dateTime must not be after queryInfo.creationTime",
              path: [
                "value",
                "timeSeries",
                seriesIndex,
                "values",
                groupIndex,
                "value",
                observationIndex,
                "dateTime",
              ],
            });
          }
        }
      }
    }
  });

/**
 * The river vocabulary, stamped onto every station this parser emits. The
 * generic layer (`@dasher/station-domain`) computes with these words; it
 * never chooses them.
 */
const RIVER_STATION_WORDS = {
  kindLabel: "gauge",
  primaryLabel: "Water-level",
  secondaryLabel: "Streamflow",
  sourceName: "U.S. Geological Survey",
  evidencePrefix: "usgs",
} as const;

function createUsgsPayloadSnapshot(input: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("USGS payload must be JSON-serializable");
  }

  if (serialized === undefined) {
    throw new Error("USGS payload must be JSON-serializable");
  }

  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > USGS_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `USGS payload exceeds the ${USGS_PAYLOAD_MAX_BYTES}-byte serialized limit`,
    );
  }

  return JSON.parse(serialized) as unknown;
}

function assertTotalObservationBudget(
  response: z.infer<typeof ResponseSchema>,
): void {
  const totalObservations = response.value.timeSeries.reduce(
    (responseTotal, timeSeries) =>
      responseTotal +
      timeSeries.values.reduce(
        (seriesTotal, group) => seriesTotal + group.value.length,
        0,
      ),
    0,
  );

  if (totalObservations > USGS_MAX_TOTAL_OBSERVATIONS) {
    throw new Error(
      `USGS payload exceeds the ${USGS_MAX_TOTAL_OBSERVATIONS}-observation cumulative limit`,
    );
  }
}

function friendlyRiverName(siteName: string): string {
  const upper = siteName.toUpperCase();
  if (upper.startsWith("SACRAMENTO")) return "Sacramento River";
  if (upper.startsWith("AMERICAN")) return "American River";
  return siteName.replace(/\s+R\s+.*/i, " River");
}

export function parseUsgsInstantaneousValues(input: unknown): Station[] {
  const snapshot = createUsgsPayloadSnapshot(input);
  const response = ResponseSchema.parse(snapshot);
  assertTotalObservationBudget(response);
  const gauges = new Map<string, Station>();

  for (const timeSeries of response.value.timeSeries) {
    const siteId = timeSeries.sourceInfo.siteCode[0]!.value;
    const parameterCode = timeSeries.variable.variableCode[0]!.value;
    if (parameterCode !== "00065" && parameterCode !== "00060") continue;
    const unit = timeSeries.variable.unit.unitCode;
    if (parameterCode === "00065" && unit !== "ft") {
      throw new Error(
        `USGS stage series ${siteId} must use ft, received ${unit}`,
      );
    }
    if (parameterCode === "00060" && unit !== "ft3/s") {
      throw new Error(
        `USGS streamflow series ${siteId} must use ft3/s, received ${unit}`,
      );
    }

    const noDataValue = timeSeries.variable.noDataValue;
    const observations = timeSeries.values
      .flatMap((group) => group.value)
      .flatMap((item) => {
        const text = item.value.trim();
        if (text.length === 0) return [];
        const value = Number(text);
        if (!Number.isFinite(value) || value === noDataValue) return [];
        return [{ at: new Date(item.dateTime).toISOString(), value }];
      })
      .sort((a, b) => a.at.localeCompare(b.at));

    const existing = gauges.get(siteId) ?? {
      siteId,
      name: timeSeries.sourceInfo.siteName,
      group: friendlyRiverName(timeSeries.sourceInfo.siteName),
      ...RIVER_STATION_WORDS,
      latitude: timeSeries.sourceInfo.geoLocation.geogLocation.latitude,
      longitude: timeSeries.sourceInfo.geoLocation.geogLocation.longitude,
      sourceUrl: `https://waterdata.usgs.gov/monitoring-location/${siteId}/`,
      retrievedAt: new Date(response.value.queryInfo.retrievedAt).toISOString(),
    };

    const series: Series = { unit, observations };

    if (parameterCode === "00065") existing.primary = series;
    if (parameterCode === "00060") existing.secondary = series;
    gauges.set(siteId, existing);
  }

  return [...gauges.values()].sort((a, b) => a.name.localeCompare(b.name));
}
