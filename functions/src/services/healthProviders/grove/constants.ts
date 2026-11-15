// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Canonical URLs, codes and the measurement table used to encode wearable
 * provider data as Grove FHIR 0.8.0 (https://grovealliance.org/fhir). The
 * measurement rows below are transcribed from grove-fhir
 * `catalog/measurement-catalog.json`; which rows a provider source type may
 * emit is transcribed from `catalog/providers-adapter.json` (see
 * `providerCatalog.ts`).
 */

import { HealthProviderId } from "../../../models/index.js";

const GROVE = "https://grovealliance.org/fhir";
export const MHC_FHIR_ROOT = "https://myheartcounts.stanford.edu/fhir";

export const GroveUrl = {
  identifierRole: `${GROVE}/mobile/CodeSystem/grove-identifier-role`,
  aggregationMethod: `${GROVE}/mobile/CodeSystem/grove-aggregation-method`,
  recordingMethodSystem: `${GROVE}/mobile/CodeSystem/grove-recording-method`,
  recordingMethodExtension: `${GROVE}/mobile/StructureDefinition/grove-recording-method`,
  mobileMeasurement: `${GROVE}/mobile/CodeSystem/grove-mobile-measurement`,
  sleepStage: `${GROVE}/mobile/CodeSystem/grove-sleep-stage`,
  workoutActivity: `${GROVE}/mobile/CodeSystem/grove-workout-activity`,
  workoutStatistic: `${GROVE}/mobile/CodeSystem/grove-workout-statistic`,
  entryKeyExtension: `${GROVE}/mobile/StructureDefinition/grove-exchange-entry-key`,
  recordVersionExtension: `${GROVE}/mobile/StructureDefinition/grove-record-version`,
  exchangeBundleProfile: `${GROVE}/mobile/StructureDefinition/grove-mobile-exchange-bundle`,
  applicationDeviceProfile: `${GROVE}/mobile/StructureDefinition/grove-application-device`,
  providerExtension: `${GROVE}/providers/StructureDefinition/provider`,
  providerSourceTypeExtension: `${GROVE}/providers/StructureDefinition/provider-source-type`,
  providerConversionProvenanceProfile: `${GROVE}/providers/StructureDefinition/providers-conversion-provenance`,
  providerRecordingDocumentProfile: `${GROVE}/providers/StructureDefinition/providers-recording-document`,
  sensorRecordingDocumentProfile: `${GROVE}/sensor/StructureDefinition/grove-sensor-recording-document`,
  recordingFormat: `${GROVE}/sensor/CodeSystem/grove-recording-format`,
  timezoneExtension: "http://hl7.org/fhir/StructureDefinition/timezone",
  observationCategory:
    "http://terminology.hl7.org/CodeSystem/observation-category",
  isoLifecycle: "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle",
  provenanceParticipantType:
    "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
  mdc: "urn:iso:std:iso:11073:10101",
  ucum: "http://unitsofmeasure.org",
  loinc: "http://loinc.org",
} as const;

/** MyHeart Counts URLs used for subject, provider scope and out-of-IG extras. */
export const MhcUrl = {
  participant: `${MHC_FHIR_ROOT}/identifiers/participant`,
  providerAccount: (providerCode: string) =>
    `${MHC_FHIR_ROOT}/identifiers/provider-account/${providerCode}`,
  providerKeySpace: `${MHC_FHIR_ROOT}/NamingSystem/provider-key-space`,
  /** CodeSystem for available provider fields the Grove provider catalog does not inventory. */
  providerMeasurement: `${MHC_FHIR_ROOT}/CodeSystem/provider-measurement`,
  /** Provider-native enumerations carried as codings on out-of-catalog extras. */
  providerToken: (provider: string, field: string) =>
    `${MHC_FHIR_ROOT}/CodeSystem/${provider}-${field}`,
  /** `meta.tag` system marking a resource as outside the Grove provider catalog. */
  conformanceTag: `${MHC_FHIR_ROOT}/CodeSystem/grove-conformance`,
} as const;

export const OUTSIDE_CATALOG_TAG = {
  system: MhcUrl.conformanceTag,
  code: "outside-provider-catalog",
  display: "Not admitted by the Grove FHIR 0.8.0 provider catalog",
} as const;

/** Grove provider codes (`providers/CodeSystem/provider`). */
export const groveProviderCode: Record<HealthProviderId, string> = {
  [HealthProviderId.oura]: "oura",
  [HealthProviderId.withings]: "withings",
  [HealthProviderId.googleHealth]: "google-health-api",
};

/** Vendor envelope profile that every provider Observation claims. */
export const vendorEnvelopeProfile: Record<HealthProviderId, string> = {
  [HealthProviderId.oura]: `${GROVE}/oura/StructureDefinition/oura-observation`,
  [HealthProviderId.withings]: `${GROVE}/withings/StructureDefinition/withings-observation`,
  [HealthProviderId.googleHealth]: `${GROVE}/google-health/StructureDefinition/google-health-observation`,
};

/**
 * Provider identity scope mode: Oura documents a global document-id key space;
 * Google Health and Withings ids are account scoped.
 */
export const providerScopeMode: Record<HealthProviderId, "account" | "global"> =
  {
    [HealthProviderId.oura]: "global",
    [HealthProviderId.withings]: "account",
    [HealthProviderId.googleHealth]: "account",
  };

export interface Coding {
  system: string;
  code: string;
  display?: string;
}

export interface QuantityUnit {
  code: string;
  unit: string;
}

export type AggregationMethod =
  | "daily-total"
  | "daily-mean"
  | "daily-minimum"
  | "daily-maximum"
  | "session-mean"
  | "session-total"
  | "rolling-mean"
  | "percentage-of-time"
  | "session-minimum"
  | "session-rate";

export interface GroveMeasurement {
  id: string;
  /** Full canonical URL of the semantic profile. */
  profile: string;
  code: Coding;
  /** Additional required codings (e.g. none today). */
  category?: "vital-signs" | "activity";
  unit?: QuantityUnit;
  effective: "dateTime" | "Period" | "dateTime-or-Period";
  /** Fixed method, when the profile fixes one. */
  method?: AggregationMethod;
  integerOnly?: boolean;
}

const mobileProfile = (id: string) =>
  `${GROVE}/mobile/StructureDefinition/${id}`;
const vendorProfile = (owner: string, id: string) =>
  `${GROVE}/${owner}/StructureDefinition/${id}`;
const loinc = (code: string, display?: string): Coding => ({
  system: GroveUrl.loinc,
  code,
  display,
});
const mobileCode = (code: string, display: string): Coding => ({
  system: GroveUrl.mobileMeasurement,
  code,
  display,
});
const withingsCode = (code: string, display: string): Coding => ({
  system: `${GROVE}/withings/CodeSystem/withings-measurement`,
  code,
  display,
});
const unit = (code: string, unitText: string = code): QuantityUnit => ({
  code,
  unit: unitText,
});

const measurementList: GroveMeasurement[] = [
  // Activity
  {
    id: "step-count",
    profile: mobileProfile("grove-mobile-step-count"),
    code: mobileCode("step-count-total", "Step count total"),
    category: "activity",
    unit: unit("{steps}", "steps"),
    effective: "Period",
    integerOnly: true,
  },
  {
    id: "distance",
    profile: mobileProfile("grove-mobile-distance"),
    code: loinc("103208-5", "Distance"),
    category: "activity",
    unit: unit("m"),
    effective: "Period",
  },
  {
    id: "active-energy",
    profile: mobileProfile("grove-mobile-active-energy"),
    code: mobileCode("active-energy-burned", "Active energy burned"),
    category: "activity",
    unit: unit("kcal"),
    effective: "Period",
  },
  {
    id: "basal-energy",
    profile: mobileProfile("grove-mobile-basal-energy"),
    code: mobileCode("basal-energy-burned", "Basal energy burned"),
    category: "activity",
    unit: unit("kcal"),
    effective: "Period",
  },
  {
    id: "flights-climbed",
    profile: mobileProfile("grove-mobile-flights-climbed"),
    code: loinc("100304-5", "Flights climbed [#] Reporting Period"),
    category: "activity",
    unit: unit("{flights}", "flights"),
    effective: "Period",
    integerOnly: true,
  },
  {
    id: "workout",
    profile: mobileProfile("grove-mobile-workout"),
    code: mobileCode("workout", "Workout session"),
    category: "activity",
    effective: "Period",
  },
  {
    id: "vo2-max",
    profile: mobileProfile("grove-mobile-vo2-max"),
    code: mobileCode("vo2-max", "VO2 max"),
    unit: unit("mL/kg/min"),
    effective: "dateTime",
  },
  // Vital signs
  {
    id: "heart-rate",
    profile: mobileProfile("grove-mobile-heart-rate"),
    code: loinc("8867-4", "Heart rate"),
    category: "vital-signs",
    unit: unit("/min", "beats/minute"),
    effective: "dateTime-or-Period",
  },
  {
    id: "sleep-heart-rate",
    profile: mobileProfile("grove-mobile-sleep-heart-rate"),
    code: mobileCode("sleep-heart-rate", "Sleep heart rate"),
    unit: unit("/min", "beats/minute"),
    effective: "Period",
  },
  {
    id: "heart-rate-variability-rmssd",
    profile: mobileProfile("grove-mobile-heart-rate-variability-rmssd"),
    code: mobileCode(
      "heart-rate-variability-rmssd",
      "Heart rate variability RMSSD",
    ),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "heart-rate-variability-sdnn",
    profile: mobileProfile("grove-mobile-heart-rate-variability-sdnn"),
    code: loinc("112429-6", "Heart rate variability SDNN [Time]"),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "oxygen-saturation",
    profile: mobileProfile("grove-mobile-oxygen-saturation"),
    code: loinc("2708-6", "Oxygen saturation in Arterial blood"),
    category: "vital-signs",
    unit: unit("%"),
    effective: "dateTime",
  },
  {
    id: "oxygen-saturation-daily-average",
    profile: mobileProfile("grove-mobile-oxygen-saturation-daily-average"),
    code: loinc("103209-3", "Mean oxygen saturation"),
    unit: unit("%"),
    effective: "Period",
    method: "daily-mean",
  },
  {
    id: "respiratory-rate-average",
    profile: mobileProfile("grove-mobile-respiratory-rate-average"),
    code: loinc("103217-6", "Mean respiratory rate"),
    unit: unit("/min", "breaths/minute"),
    effective: "Period",
  },
  {
    id: "body-temperature",
    profile: mobileProfile("grove-mobile-body-temperature"),
    code: loinc("8310-5", "Body temperature"),
    category: "vital-signs",
    unit: unit("Cel"),
    effective: "dateTime",
  },
  {
    id: "skin-temperature",
    profile: mobileProfile("grove-mobile-skin-temperature"),
    code: loinc("61008-9", "Body surface temperature"),
    unit: unit("Cel"),
    effective: "dateTime",
  },
  {
    id: "blood-pressure",
    profile: mobileProfile("grove-mobile-blood-pressure"),
    code: loinc("85354-9", "Blood pressure panel with all children optional"),
    category: "vital-signs",
    effective: "dateTime",
  },
  {
    id: "blood-glucose-unspecified-specimen",
    profile: mobileProfile("grove-mobile-blood-glucose-unspecified-specimen"),
    code: loinc("2339-0", "Glucose [Mass/volume] in Blood"),
    unit: unit("mg/dL"),
    effective: "dateTime",
  },
  {
    id: "resting-heart-rate-daily-average",
    profile: vendorProfile(
      "google-health",
      "google-health-daily-resting-heart-rate",
    ),
    code: {
      system: `${GROVE}/google-health/CodeSystem/google-health-measurement`,
      code: "resting-heart-rate-daily-average",
      display: "Resting heart rate daily average",
    },
    unit: unit("/min", "beats/minute"),
    effective: "Period",
    method: "daily-mean",
  },
  // Body measurements
  {
    id: "body-weight",
    profile: mobileProfile("grove-mobile-body-weight"),
    code: loinc("29463-7", "Body weight"),
    category: "vital-signs",
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "body-height",
    profile: mobileProfile("grove-mobile-body-height"),
    code: loinc("8302-2", "Body height"),
    category: "vital-signs",
    unit: unit("cm"),
    effective: "dateTime",
  },
  {
    id: "body-fat-percentage",
    profile: mobileProfile("grove-mobile-body-fat-percentage"),
    code: loinc("41982-0", "Percentage of body fat Measured"),
    unit: unit("%"),
    effective: "dateTime",
  },
  {
    id: "body-fat-mass",
    profile: vendorProfile("withings", "withings-body-fat-mass"),
    code: loinc("73708-0", "Body fat [Mass] Calculated"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "lean-body-mass",
    profile: mobileProfile("grove-mobile-lean-body-mass"),
    code: loinc("91557-9", "Lean body weight"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "muscle-mass",
    profile: vendorProfile("withings", "withings-muscle-mass"),
    code: loinc("73964-9", "Body muscle mass Calculated"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "bone-mass",
    profile: mobileProfile("grove-mobile-bone-mass"),
    code: loinc("101685-6", "Body bone mass"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "body-water-mass",
    profile: mobileProfile("grove-mobile-body-water-mass"),
    code: loinc("101683-1", "Body water mass"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "extracellular-water-mass",
    profile: vendorProfile("withings", "withings-extracellular-water-mass"),
    code: withingsCode("extracellular-water-mass", "Extracellular water mass"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "intracellular-water-mass",
    profile: vendorProfile("withings", "withings-intracellular-water-mass"),
    code: withingsCode("intracellular-water-mass", "Intracellular water mass"),
    unit: unit("kg"),
    effective: "dateTime",
  },
  {
    id: "withings-visceral-fat-index",
    profile: vendorProfile("withings", "withings-visceral-fat-index"),
    code: withingsCode(
      "withings-visceral-fat-index",
      "Withings visceral fat index",
    ),
    unit: unit("{score}", "score"),
    effective: "dateTime",
  },
  {
    id: "withings-pulse-wave-velocity",
    profile: vendorProfile("withings", "withings-pulse-wave-velocity"),
    code: withingsCode(
      "withings-pulse-wave-velocity",
      "Withings pulse wave velocity",
    ),
    unit: unit("m/s"),
    effective: "dateTime",
  },
  {
    id: "withings-vascular-age",
    profile: vendorProfile("withings", "withings-vascular-age"),
    code: withingsCode("withings-vascular-age", "Withings vascular age"),
    unit: unit("a", "years"),
    effective: "dateTime",
  },
  {
    id: "withings-nerve-health-score",
    profile: vendorProfile("withings", "withings-nerve-health-score"),
    code: withingsCode(
      "withings-nerve-health-score",
      "Withings nerve health score",
    ),
    unit: unit("{score}", "score"),
    effective: "dateTime",
  },
  {
    id: "electrodermal-activity",
    profile: mobileProfile("grove-mobile-electrodermal-activity"),
    code: mobileCode("electrodermal-activity", "Electrodermal activity"),
    unit: unit("uS"),
    effective: "dateTime",
  },
  {
    id: "withings-atrial-fibrillation-notification-ecg",
    profile: vendorProfile(
      "withings",
      "withings-atrial-fibrillation-notification-ecg",
    ),
    code: withingsCode(
      "withings-atrial-fibrillation-notification-ecg",
      "Withings atrial fibrillation notification (ECG)",
    ),
    effective: "dateTime",
  },
  {
    id: "withings-atrial-fibrillation-notification-ppg",
    profile: vendorProfile(
      "withings",
      "withings-atrial-fibrillation-notification-ppg",
    ),
    code: withingsCode(
      "withings-atrial-fibrillation-notification-ppg",
      "Withings atrial fibrillation notification (PPG)",
    ),
    effective: "dateTime",
  },
  {
    id: "qrs-duration",
    profile: vendorProfile("withings", "withings-qrs-duration"),
    code: loinc("8633-0", "QRS duration"),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "pr-interval",
    profile: vendorProfile("withings", "withings-pr-interval"),
    code: loinc("8625-6", "P-R Interval"),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "qt-interval",
    profile: vendorProfile("withings", "withings-qt-interval"),
    code: loinc("8634-8", "Q-T interval"),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "corrected-qt-interval",
    profile: vendorProfile("withings", "withings-corrected-qt-interval"),
    code: loinc("8636-3", "Q-T interval corrected"),
    unit: unit("ms"),
    effective: "dateTime",
  },
  {
    id: "oura-cardiovascular-age",
    profile: vendorProfile("oura", "oura-cardiovascular-age"),
    code: {
      system: `${GROVE}/oura/CodeSystem/oura-measurement`,
      code: "oura-cardiovascular-age",
      display: "Oura cardiovascular age",
    },
    unit: unit("a", "years"),
    effective: "Period",
  },
  {
    id: "oura-readiness-score",
    profile: vendorProfile("oura", "oura-readiness-score"),
    code: {
      system: `${GROVE}/oura/CodeSystem/oura-measurement`,
      code: "oura-readiness-score",
      display: "Oura readiness score",
    },
    unit: unit("{score}", "score"),
    effective: "Period",
  },
  // Sleep
  {
    id: "sleep-duration",
    profile: mobileProfile("grove-mobile-sleep-duration"),
    code: loinc("93832-4", "Sleep duration"),
    unit: unit("h"),
    effective: "Period",
  },
  {
    id: "deep-sleep-duration",
    profile: mobileProfile("grove-mobile-deep-sleep-duration"),
    code: loinc("93831-6", "Deep sleep duration"),
    unit: unit("min"),
    effective: "Period",
    method: "session-total",
  },
  {
    id: "rem-sleep-duration",
    profile: mobileProfile("grove-mobile-rem-sleep-duration"),
    code: loinc("93829-0", "REM sleep duration"),
    unit: unit("min"),
    effective: "Period",
    method: "session-total",
  },
  {
    id: "light-sleep-duration",
    profile: mobileProfile("grove-mobile-light-sleep-duration"),
    code: loinc("93830-8", "Light sleep duration"),
    unit: unit("min"),
    effective: "Period",
    method: "session-total",
  },
  {
    id: "sleep-awake-duration",
    profile: mobileProfile("grove-mobile-sleep-awake-duration"),
    code: loinc("93828-2", "Nighttime awakening duration"),
    unit: unit("min"),
    effective: "Period",
    method: "session-total",
  },
  {
    id: "sleep-stage",
    profile: mobileProfile("grove-mobile-sleep-stage"),
    code: mobileCode("sleep-stage", "Sleep stage"),
    effective: "Period",
  },
];

export const GroveMeasurements: Readonly<
  Partial<Record<string, GroveMeasurement>>
> = Object.fromEntries(measurementList.map((m) => [m.id, m]));

export const groveMeasurement = (id: string): GroveMeasurement => {
  const measurement = GroveMeasurements[id];
  if (measurement === undefined) {
    throw new Error(`Unknown Grove measurement ${id}`);
  }
  return measurement;
};

/**
 * MyHeart Counts provider-measurement CodeSystem. Every code is for an
 * available provider field that no Grove 0.8.0 profile models. Resources using
 * it carry only the vendor envelope profile plus {@link OUTSIDE_CATALOG_TAG}.
 */
export interface MhcMeasurement {
  code: string;
  display: string;
  unit?: QuantityUnit;
  category?: "vital-signs" | "activity";
}

const mhc = (
  code: string,
  display: string,
  quantityUnit?: QuantityUnit,
  category?: "activity",
): MhcMeasurement => ({ code, display, unit: quantityUnit, category });

export const MhcMeasurements = {
  sleepScore: mhc(
    "sleep-score",
    "Provider sleep score",
    unit("{score}", "score"),
  ),
  sleepEfficiency: mhc("sleep-efficiency", "Sleep efficiency", unit("%")),
  sleepLatency: mhc("sleep-latency", "Sleep latency", unit("min")),
  timeInBed: mhc("time-in-bed", "Time in bed", unit("min")),
  sleepHrvRmssd: mhc(
    "sleep-heart-rate-variability-rmssd",
    "Sleep-session average heart rate variability (RMSSD)",
    unit("ms"),
  ),
  sleepHeartRateMaximum: mhc(
    "sleep-heart-rate-maximum",
    "Sleep-session maximum heart rate",
    unit("/min", "beats/minute"),
  ),
  sleepRespiratoryRateMinimum: mhc(
    "sleep-respiratory-rate-minimum",
    "Sleep-session minimum respiratory rate",
    unit("/min", "breaths/minute"),
  ),
  sleepRespiratoryRateMaximum: mhc(
    "sleep-respiratory-rate-maximum",
    "Sleep-session maximum respiratory rate",
    unit("/min", "breaths/minute"),
  ),
  sleepPeriodType: mhc("sleep-period-type", "Provider sleep period type"),
  sleepAwakeningCount: mhc(
    "sleep-awakening-count",
    "Number of awakenings during the sleep session",
    unit("{count}", "count"),
  ),
  snoringDuration: mhc("snoring-duration", "Snoring duration", unit("min")),
  snoringEpisodeCount: mhc(
    "snoring-episode-count",
    "Snoring episode count",
    unit("{count}", "count"),
  ),
  breathingDisturbanceIndex: mhc(
    "breathing-disturbance-index",
    "Provider breathing disturbance index",
    unit("{score}", "score"),
  ),
  activityScore: mhc(
    "activity-score",
    "Provider activity score",
    unit("{score}", "score"),
    "activity",
  ),
  totalEnergyBurned: mhc(
    "total-energy-burned",
    "Total energy burned (active plus basal)",
    unit("kcal"),
    "activity",
  ),
  highActivityDuration: mhc(
    "high-activity-duration",
    "Time in high-intensity activity",
    unit("min"),
    "activity",
  ),
  mediumActivityDuration: mhc(
    "medium-activity-duration",
    "Time in medium-intensity activity",
    unit("min"),
    "activity",
  ),
  lowActivityDuration: mhc(
    "low-activity-duration",
    "Time in low-intensity activity",
    unit("min"),
    "activity",
  ),
  activeDuration: mhc(
    "active-duration",
    "Total active time",
    unit("min"),
    "activity",
  ),
  sedentaryDuration: mhc(
    "sedentary-duration",
    "Sedentary time",
    unit("min"),
    "activity",
  ),
  elevationGain: mhc(
    "elevation-gain",
    "Elevation gained",
    unit("m"),
    "activity",
  ),
  temperatureDeviation: mhc(
    "temperature-deviation",
    "Body temperature deviation from personal baseline",
    unit("Cel"),
  ),
  temperatureTrendDeviation: mhc(
    "temperature-trend-deviation",
    "Body temperature trend deviation from personal baseline",
    unit("Cel"),
  ),
  oxygenSaturationDailyLowerBound: mhc(
    "oxygen-saturation-daily-lower-bound",
    "Daily oxygen saturation lower bound",
    unit("%"),
  ),
  oxygenSaturationDailyUpperBound: mhc(
    "oxygen-saturation-daily-upper-bound",
    "Daily oxygen saturation upper bound",
    unit("%"),
  ),
  pulseWaveVelocity: mhc(
    "pulse-wave-velocity",
    "Provider-estimated pulse wave velocity",
    unit("m/s"),
  ),
  workoutIntensity: mhc(
    "workout-intensity",
    "Provider workout intensity",
    undefined,
    "activity",
  ),
  workoutLabel: mhc(
    "workout-label",
    "Provider workout label",
    undefined,
    "activity",
  ),
} as const;

/** Grove workout activities (`grove-workout-activity`). */
export const GROVE_WORKOUT_ACTIVITIES = new Set([
  "running",
  "walking",
  "cycling",
  "hiking",
  "swimming",
  "strength-training",
  "high-intensity-interval-training",
  "yoga",
  "pilates",
  "rowing",
  "elliptical",
  "stair-climbing",
  "dancing",
  "tennis",
  "table-tennis",
  "badminton",
  "squash",
  "basketball",
  "soccer",
  "american-football",
  "baseball",
  "volleyball",
  "golf",
  "boxing",
  "martial-arts",
  "skiing",
  "snowboarding",
  "other",
]);

/**
 * Map a provider workout token to a Grove workout activity. Matching is on a
 * normalized lower-case token so `RUNNING`, `running` and `run` all map; unknown
 * activities fall back to `other` (the provider token is kept in `value.text`).
 */
export const groveWorkoutActivity = (
  providerToken: string | undefined,
): string => {
  if (providerToken === undefined) return "other";
  const token = providerToken.toLowerCase().replace(/[\s_]+/g, "-");
  if (GROVE_WORKOUT_ACTIVITIES.has(token)) return token;
  const aliases: Record<string, string> = {
    run: "running",
    "treadmill-running": "running",
    "trail-running": "running",
    walk: "walking",
    "indoor-walking": "walking",
    bike: "cycling",
    biking: "cycling",
    "indoor-cycling": "cycling",
    "stationary-bike": "cycling",
    "mountain-biking": "cycling",
    spinning: "cycling",
    swim: "swimming",
    "pool-swimming": "swimming",
    "open-water-swimming": "swimming",
    "weight-training": "strength-training",
    weights: "strength-training",
    weightlifting: "strength-training",
    "weight-lifting": "strength-training",
    "strength-workout": "strength-training",
    hiit: "high-intensity-interval-training",
    "interval-workout": "high-intensity-interval-training",
    rower: "rowing",
    "rowing-machine": "rowing",
    "elliptical-trainer": "elliptical",
    "stair-climber": "stair-climbing",
    stairmaster: "stair-climbing",
    dance: "dancing",
    "ping-pong": "table-tennis",
    football: "soccer",
    "american-football": "american-football",
    "downhill-skiing": "skiing",
    "cross-country-skiing": "skiing",
    "alpine-skiing": "skiing",
    "martial-arts": "martial-arts",
    kickboxing: "boxing",
  };
  return aliases[token] ?? "other";
};
