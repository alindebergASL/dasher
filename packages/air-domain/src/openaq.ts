import { z } from "zod";

import type {
  Series,
  Station,
  StationComputation,
} from "@dasher/station-domain";

/**
 * The second domain: air-quality monitors, from OpenAQ v3 payloads.
 *
 * This is the parser whose cost the generality spike could not measure
 * (`docs/process/2026-08-18-is-the-compiler-river-shaped.md`) — the spike
 * hand-built typed objects, and this package is the part it skipped: refusing
 * malformed input, bounding payloads, and recording provenance for a real
 * wire format.
 *
 * WHAT THE INPUT IS. OpenAQ v3 serves locations and hourly measurements from
 * separate endpoints (`/v3/locations`, `/v3/sensors/{id}/hours`), unlike the
 * USGS instantaneous-values service, which answers in one response. The
 * parser therefore takes a snapshot bundle — the two responses verbatim, plus
 * the retrieval time — which is what a fetch layer naturally assembles and
 * what a fixture can hold byte for byte. Each `locations`/`hours` payload
 * inside the bundle is the wire shape, unmodified.
 *
 * WHAT COMES OUT. `Station[]` — the same type the river parser emits, with
 * this domain's words on it: a station is a "monitor", its group is its
 * locality, its primary reading is PM2.5 and its secondary is ozone. The
 * generic layer computes with those words and never chooses them.
 */

export const OPENAQ_PAYLOAD_MAX_BYTES = 5 * 1_024 * 1_024;
export const OPENAQ_MAX_TOTAL_MEASUREMENTS = 20_000;

export const OPENAQ_STRING_LIMITS = {
  locationName: 256,
  locality: 256,
  parameterName: 64,
  units: 32,
  isoTimestamp: 64,
} as const;

/** The two parameters this domain reads. Everything else is skipped. */
const PRIMARY_PARAMETER = "pm25";
const SECONDARY_PARAMETER = "o3";
const PRIMARY_UNITS = "µg/m³";
const SECONDARY_UNITS = "ppm";

const AIR_STATION_WORDS = {
  kindLabel: "monitor",
  primaryLabel: "PM2.5",
  secondaryLabel: "Ozone",
  sourceName: "OpenAQ",
  evidencePrefix: "openaq",
} as const;

const TimestampSchema = z
  .string()
  .max(OPENAQ_STRING_LIMITS.isoTimestamp)
  .datetime({ offset: true });

const SensorSchema = z.object({
  id: z.number().int().positive(),
  parameter: z.object({
    name: z.string().min(1).max(OPENAQ_STRING_LIMITS.parameterName),
    units: z.string().min(1).max(OPENAQ_STRING_LIMITS.units),
    displayName: z.string().min(1).max(OPENAQ_STRING_LIMITS.parameterName),
  }),
});

const LocationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(OPENAQ_STRING_LIMITS.locationName),
  locality: z
    .string()
    .min(1)
    .max(OPENAQ_STRING_LIMITS.locality)
    .nullable()
    .optional(),
  coordinates: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  isMonitor: z.boolean(),
  sensors: z
    .array(SensorSchema)
    .min(1)
    .max(32, "Too many sensors on an OpenAQ location"),
});

const HourSchema = z.object({
  value: z.number(),
  period: z.object({
    datetimeTo: z.object({ utc: TimestampSchema }),
  }),
});

const BundleSchema = z
  .object({
    retrievedAt: TimestampSchema,
    locations: z.object({
      results: z
        .array(LocationSchema)
        .min(1)
        .max(200, "Too many locations in OpenAQ response"),
    }),
    hours: z.record(
      z.string().regex(/^\d+$/, "Sensor keys must be numeric ids"),
      z.object({
        results: z
          .array(HourSchema)
          .max(10_000, "Too many measurements in an OpenAQ hours response"),
      }),
    ),
  })
  .superRefine((bundle, context) => {
    const retrievedAt = Date.parse(bundle.retrievedAt);
    for (const [sensorId, hours] of Object.entries(bundle.hours)) {
      for (const [index, hour] of hours.results.entries()) {
        if (Date.parse(hour.period.datetimeTo.utc) > retrievedAt) {
          context.addIssue({
            code: "custom",
            message:
              "OpenAQ measurement must not end after the bundle's retrievedAt",
            path: ["hours", sensorId, "results", index],
          });
        }
      }
    }
  });

function createPayloadSnapshot(input: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("OpenAQ payload must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new Error("OpenAQ payload must be JSON-serializable");
  }
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > OPENAQ_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `OpenAQ payload exceeds the ${OPENAQ_PAYLOAD_MAX_BYTES}-byte serialized limit`,
    );
  }
  return JSON.parse(serialized) as unknown;
}

function assertTotalMeasurementBudget(
  bundle: z.infer<typeof BundleSchema>,
): void {
  const total = Object.values(bundle.hours).reduce(
    (sum, hours) => sum + hours.results.length,
    0,
  );
  if (total > OPENAQ_MAX_TOTAL_MEASUREMENTS) {
    throw new Error(
      `OpenAQ payload exceeds the ${OPENAQ_MAX_TOTAL_MEASUREMENTS}-measurement cumulative limit`,
    );
  }
}

function seriesFor(
  bundle: z.infer<typeof BundleSchema>,
  sensor: z.infer<typeof SensorSchema>,
): Series | undefined {
  const hours = bundle.hours[String(sensor.id)];
  // A sensor with no hours in the bundle is a station whose reading is
  // missing, which the metrics layer reports; it is not a parse error.
  if (hours === undefined) return undefined;

  const observations = hours.results
    .filter((hour) => Number.isFinite(hour.value) && hour.value >= 0)
    .map((hour) => ({
      at: new Date(hour.period.datetimeTo.utc).toISOString(),
      value: hour.value,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  return { unit: sensor.parameter.units, observations };
}

export function parseOpenAqHourlySnapshot(input: unknown): Station[] {
  const snapshot = createPayloadSnapshot(input);
  const bundle = BundleSchema.parse(snapshot);
  assertTotalMeasurementBudget(bundle);

  const stations: Station[] = [];
  for (const location of bundle.locations.results) {
    // Reference-grade monitors only: OpenAQ also carries low-cost sensors,
    // and mixing calibration classes into one dashboard without saying so
    // would be a claim the evidence records could not back.
    if (!location.isMonitor) continue;

    const pm25 = location.sensors.find(
      (sensor) => sensor.parameter.name === PRIMARY_PARAMETER,
    );
    const ozone = location.sensors.find(
      (sensor) => sensor.parameter.name === SECONDARY_PARAMETER,
    );
    // A monitor with no PM2.5 sensor has no primary reading to build a
    // dashboard around; skipped rather than emitted as a permanently-missing
    // station.
    if (pm25 === undefined) continue;

    if (pm25.parameter.units !== PRIMARY_UNITS) {
      throw new Error(
        `OpenAQ pm25 sensor ${pm25.id} must use ${PRIMARY_UNITS}, received ${pm25.parameter.units}`,
      );
    }
    if (ozone !== undefined && ozone.parameter.units !== SECONDARY_UNITS) {
      throw new Error(
        `OpenAQ o3 sensor ${ozone.id} must use ${SECONDARY_UNITS}, received ${ozone.parameter.units}`,
      );
    }

    const primary = seriesFor(bundle, pm25);
    const secondary =
      ozone === undefined ? undefined : seriesFor(bundle, ozone);

    stations.push({
      siteId: String(location.id),
      name: location.name,
      group: location.locality ?? location.name,
      ...AIR_STATION_WORDS,
      latitude: location.coordinates.latitude,
      longitude: location.coordinates.longitude,
      ...(primary === undefined ? {} : { primary }),
      ...(secondary === undefined ? {} : { secondary }),
      sourceUrl: `https://explore.openaq.org/locations/${location.id}`,
      retrievedAt: new Date(bundle.retrievedAt).toISOString(),
    });
  }

  return stations.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The air domain's computation policy, sibling to the river's 0.05 ft. PM2.5
 * hovers by fractions of a µg/m³: a change smaller than 2 µg/m³ in an hour is
 * noise, and a rise has to clear 5 µg/m³ before this domain calls it
 * material. Passed to `compilePlan` alongside this parser's stations — the
 * stations carry the words, this carries the numbers and the sentence for
 * Dasher's own arithmetic.
 */
export const AIR_COMPUTATION: StationComputation = {
  directionTolerance: 2,
  materialRiseTolerance: 5,
  toleranceUnit: "µg/m³",
  calculations: {
    label: "Dasher air-quality calculations",
    detail:
      "One-, six-, and 24-hour changes are calculated from the nearest qualifying OpenAQ hourly measurements. Improving/worsening uses a 2 µg/m³ tolerance.",
  },
};
