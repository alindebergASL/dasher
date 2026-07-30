import { z } from "zod";

const SiteIdSchema = z.string().regex(/^\d{8,15}$/, "Invalid USGS site ID");

const ValueSchema = z.object({
  value: z.string(),
  dateTime: z.string().datetime({ offset: true }),
});

const TimeSeriesSchema = z.object({
  sourceInfo: z.object({
    siteName: z.string().min(1),
    siteCode: z.array(z.object({ value: SiteIdSchema })).min(1),
    geoLocation: z.object({
      geogLocation: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
    }),
  }),
  variable: z.object({
    variableCode: z.array(z.object({ value: z.string().min(1) })).min(1),
    variableDescription: z.string().min(1),
    unit: z.object({ unitCode: z.string().min(1) }),
    noDataValue: z.number(),
  }),
  values: z.array(z.object({ value: z.array(ValueSchema) })).min(1),
});

const ResponseSchema = z.object({
  value: z.object({
    queryInfo: z.object({
      creationTime: z.string().datetime({ offset: true }),
    }),
    timeSeries: z.array(TimeSeriesSchema).min(1),
  }),
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

function friendlyRiverName(siteName: string): string {
  const upper = siteName.toUpperCase();
  if (upper.startsWith("SACRAMENTO")) return "Sacramento River";
  if (upper.startsWith("AMERICAN")) return "American River";
  return siteName.replace(/\s+R\s+.*/i, " River");
}

export function parseUsgsInstantaneousValues(input: unknown): RiverGauge[] {
  const response = ResponseSchema.parse(input);
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
