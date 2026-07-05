// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type ProviderObservation } from "./healthProviderAdapter.js";
import { type MetricSpec } from "./providerCodes.js";
import { getPackageVersion } from "../../helpers/packageVersion.js";
import { type FHIRExtension } from "../../models/fhir/baseTypes/fhirElement.js";
import {
  FHIRObservation,
  FHIRObservationStatus,
  type FHIRReference,
  type HealthProviderId,
} from "../../models/index.js";

const SOURCE_DEFS = "https://bdh.stanford.edu/fhir/defs";

const providerSourceExtension = (
  provider: HealthProviderId,
  sourceName: string,
  sampleId: string,
): FHIRExtension[] => [
  {
    url: `${SOURCE_DEFS}/sourceRevision/source/name`,
    valueString: sourceName,
  },
  {
    url: `${SOURCE_DEFS}/healthProvider`,
    valueString: provider,
  },
  {
    url: `${SOURCE_DEFS}/healthProvider/sampleId`,
    valueString: sampleId,
  },
  {
    url: `${SOURCE_DEFS}/sourceRevision/version`,
    valueString: getPackageVersion(),
  },
];

/**
 * Deterministic Firestore document id for a provider sample. Reusing the
 * provider's native id makes re-ingestion idempotent (webhook + backfill can
 * both deliver the same sample without creating duplicates).
 */
export const providerObservationId = (
  provider: HealthProviderId,
  sampleId: string,
): string => `${provider}-${sampleId}`;

/**
 * Build a single normalized FHIR observation for a provider metric. Accepts
 * either an instant (`effectiveDateTime`) or an interval (`effectivePeriod`).
 */
export const buildProviderObservation = (params: {
  provider: HealthProviderId;
  sourceName: string;
  subject: FHIRReference;
  spec: MetricSpec;
  value: number;
  effective: Date | { start: Date; end: Date };
  sampleId: string;
}): ProviderObservation => {
  const { spec } = params;
  const isInstant = params.effective instanceof Date;

  const observation = new FHIRObservation({
    id: providerObservationId(params.provider, params.sampleId),
    status: FHIRObservationStatus.final,
    subject: params.subject,
    code: spec.concept,
    valueQuantity: {
      value: params.value,
      unit: spec.unit.unit,
      system: spec.unit.system,
      code: spec.unit.code,
    },
    effectiveDateTime: isInstant ? (params.effective as Date) : undefined,
    effectivePeriod:
      isInstant ? undefined : (params.effective as { start: Date; end: Date }),
    issued: new Date(),
    extension: providerSourceExtension(
      params.provider,
      params.sourceName,
      params.sampleId,
    ),
  });

  return { metric: spec.metric, observation };
};
