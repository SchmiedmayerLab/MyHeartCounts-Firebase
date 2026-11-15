// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Which Grove measurements each provider source type is admitted to emit,
 * transcribed from grove-fhir 0.8.0 `catalog/providers-adapter.json`
 * (rows with status `supported` or `platform-exclusive`; `mapped-standard`
 * rows are raw recordings). Anything this backend emits outside of these
 * pairs is tagged with `OUTSIDE_CATALOG_TAG`.
 */

import { HealthProviderId } from "../../../models/index.js";

type Catalog = Partial<Record<string, readonly string[]>>;

const OURA: Catalog = {
  daily_activity: ["step-count", "active-energy", "distance"],
  sleep: [
    "sleep-duration",
    "deep-sleep-duration",
    "rem-sleep-duration",
    "light-sleep-duration",
    "sleep-awake-duration",
    "sleep-heart-rate",
    "respiratory-rate-average",
  ],
  daily_spo2: ["oxygen-saturation-daily-average"],
  workout: ["workout"],
  vO2_max: ["vo2-max"],
  daily_cardiovascular_age: ["oura-cardiovascular-age"],
  daily_readiness: ["oura-readiness-score"],
};

const GOOGLE: Catalog = {
  steps: ["step-count"],
  distance: ["distance"],
  "active-energy-burned": ["active-energy"],
  weight: ["body-weight"],
  "body-fat": ["body-fat-percentage"],
  height: ["body-height"],
  "vo2-max": ["vo2-max"],
  "daily-oxygen-saturation": ["oxygen-saturation-daily-average"],
  "heart-rate-variability": [
    "heart-rate-variability-rmssd",
    "heart-rate-variability-sdnn",
  ],
  "daily-resting-heart-rate": ["resting-heart-rate-daily-average"],
  "daily-respiratory-rate": ["respiratory-rate-average"],
  "blood-glucose": ["blood-glucose-unspecified-specimen"],
  "core-body-temperature": ["body-temperature"],
  floors: ["flights-climbed"],
  "basal-energy-burned": ["basal-energy"],
  sleep: [
    "sleep-duration",
    "deep-sleep-duration",
    "rem-sleep-duration",
    "light-sleep-duration",
    "sleep-awake-duration",
  ],
  exercise: ["workout"],
};

const WITHINGS: Catalog = {
  "getmeas:1": ["body-weight"],
  "getmeas:4": ["body-height"],
  "getmeas:5": ["lean-body-mass"],
  "getmeas:6": ["body-fat-percentage"],
  "getmeas:8": ["body-fat-mass"],
  "getmeas:9+10": ["blood-pressure"],
  "getmeas:11": ["heart-rate"],
  "getmeas:54": ["oxygen-saturation"],
  "getmeas:71": ["body-temperature"],
  "getmeas:73": ["skin-temperature"],
  "getmeas:76": ["muscle-mass"],
  "getmeas:77": ["body-water-mass"],
  "getmeas:88": ["bone-mass"],
  "getmeas:91": ["withings-pulse-wave-velocity"],
  "getmeas:123": ["vo2-max"],
  "getmeas:130": ["withings-atrial-fibrillation-notification-ecg"],
  "getmeas:135": ["qrs-duration"],
  "getmeas:136": ["pr-interval"],
  "getmeas:137": ["qt-interval"],
  "getmeas:138": ["corrected-qt-interval"],
  "getmeas:139": ["withings-atrial-fibrillation-notification-ppg"],
  "getmeas:155": ["withings-vascular-age"],
  "getmeas:167": ["withings-nerve-health-score"],
  "getmeas:168": ["extracellular-water-mass"],
  "getmeas:169": ["intracellular-water-mass"],
  "getmeas:170": ["withings-visceral-fat-index"],
  "getmeas:196": ["electrodermal-activity"],
  "getactivity:steps": ["step-count"],
  "getactivity:distance": ["distance"],
  "getactivity:calories": ["active-energy"],
  "getsummary:deepsleepduration": ["deep-sleep-duration"],
  "getsummary:remsleepduration": ["rem-sleep-duration"],
  "getsummary:lightsleepduration": ["light-sleep-duration"],
  "getsummary:wakeupduration": ["sleep-awake-duration"],
  "getsummary:hr_average": ["sleep-heart-rate"],
  "getsummary:rr_average": ["respiratory-rate-average"],
  "getworkouts:interval": ["workout"],
};

const CATALOG: Record<HealthProviderId, Catalog> = {
  [HealthProviderId.oura]: OURA,
  [HealthProviderId.googleHealth]: GOOGLE,
  [HealthProviderId.withings]: WITHINGS,
};

/** Raw-recording (`mapped-standard`) source types per provider. */
const RECORDING_SOURCE_TYPES: Record<HealthProviderId, readonly string[]> = {
  [HealthProviderId.oura]: ["heartrate"],
  [HealthProviderId.googleHealth]: ["heart-rate"],
  [HealthProviderId.withings]: ["activityIntraday", "sleepIntraday"],
};

/** Whether `(provider, sourceType)` may emit `measurementId` under the catalog. */
export const isAdmittedMeasurement = (
  provider: HealthProviderId,
  sourceType: string,
  measurementId: string,
): boolean => CATALOG[provider][sourceType]?.includes(measurementId) ?? false;

/** Whether `(provider, sourceType)` is a catalog raw-recording row. */
export const isAdmittedRecording = (
  provider: HealthProviderId,
  sourceType: string,
): boolean => RECORDING_SOURCE_TYPES[provider].includes(sourceType);
