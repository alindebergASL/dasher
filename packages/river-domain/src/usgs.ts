import { z } from "zod";

export const USGS_PAYLOAD_MAX_BYTES = 5 * 1_024 * 1_024;
export const USGS_MAX_TOTAL_OBSERVATIONS = 20_000;

export const USGS_STRING_LIMITS = {
  siteName: 256,
  variableCode: 64,
  variableDescription: 512,
  unitCode: 32,
  observationValue: 128,
  isoTimestamp: 64,
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

const ResponseSchema = z
  .object({
    value: z.object({
      queryInfo: z.object({
        creationTime: UsgsTimestampSchema,
      }),
      timeSeries: z
        .array(TimeSeriesSchema)
        .min(1)
        .max(60, "Too many time series in USGS response"),
    }),
  })
  .superRefine((response, context) => {
    const creationTime = Date.parse(response.value.queryInfo.creationTime);

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

export interface Observation {
  at: string;
  value: number;
}

export interface GaugeSeries {
  parameterCode: "00065" | "00060";
  description: string;
  unit: string;
  observations: Observation[];
}

export interface RiverGauge {
  siteId: string;
  name: string;
  river: string;
  latitude: number;
  longitude: number;
  stage?: GaugeSeries;
  streamflow?: GaugeSeries;
  sourceUrl: string;
  retrievedAt: string;
}

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

export function parseUsgsInstantaneousValues(input: unknown): RiverGauge[] {
  const snapshot = createUsgsPayloadSnapshot(input);
  const response = ResponseSchema.parse(snapshot);
  assertTotalObservationBudget(response);
  const gauges = new Map<string, RiverGauge>();

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
      river: friendlyRiverName(timeSeries.sourceInfo.siteName),
      latitude: timeSeries.sourceInfo.geoLocation.geogLocation.latitude,
      longitude: timeSeries.sourceInfo.geoLocation.geogLocation.longitude,
      sourceUrl: `https://waterdata.usgs.gov/monitoring-location/${siteId}/`,
      retrievedAt: new Date(
        response.value.queryInfo.creationTime,
      ).toISOString(),
    };

    const series: GaugeSeries = {
      parameterCode,
      description: timeSeries.variable.variableDescription,
      unit,
      observations,
    };

    if (parameterCode === "00065") existing.stage = series;
    if (parameterCode === "00060") existing.streamflow = series;
    gauges.set(siteId, existing);
  }

  return [...gauges.values()].sort((a, b) => a.name.localeCompare(b.name));
}
