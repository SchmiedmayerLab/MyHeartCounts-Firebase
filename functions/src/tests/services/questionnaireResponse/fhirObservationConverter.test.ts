// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  CodingSystem,
  FHIRObservationStatus,
  Score,
} from "../../../models/index.js";
import {
  getNicotineObservationConfig,
  scoreToObservation,
} from "../../../services/questionnaireResponse/fhirObservationConverter.js";

describe("scoreToObservation", () => {
  const observation = scoreToObservation(
    new Score({
      date: new Date("2026-08-28T15:32:00.000Z"),
      overallScore: 3,
      domainScores: { statusScore: 3 },
    }),
    getNicotineObservationConfig(),
    "f4c1e7a2-5b0d-4d8e-9a3f-2c6b1e8d7a90",
    "0b6f3c1e-7d2a-4e8b-9c4d-5a1f2e3d4c5b",
    "test-user",
  );

  it("should code the sample type under the Grove and the superseded system", () => {
    expect(observation.code.coding).to.deep.equal([
      {
        code: "MHCCustomSampleTypeNicotineExposure",
        display: "Nicotine Exposure Score",
        system: CodingSystem.mhcSampleType,
      },
      {
        code: "MHCCustomSampleTypeNicotineExposure",
        display: "Nicotine Exposure Score",
        system: CodingSystem.mhcSampleTypeSuperseded,
      },
    ]);
  });

  it("should write a final observation with a UCUM count quantity", () => {
    expect(observation.status).to.equal(FHIRObservationStatus.final);
    expect(observation.valueQuantity).to.deep.equal({
      value: 3,
      unit: "count",
      system: CodingSystem.ucum,
      code: "{count}",
    });
    expect(observation.effectiveDateTime?.toISOString()).to.equal(
      "2026-08-28T15:32:00.000Z",
    );
  });

  it("should keep the MHC time zone extension and use the Grove source revision urls", () => {
    expect(
      observation.extension?.map((extension) => extension.url),
    ).to.deep.equal([
      "https://bdh.stanford.edu/fhir/defs/sampleUploadTimeZone",
      "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/source/name",
      "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/source/bundleIdentifier",
      "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/version",
      "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/OSVersion",
    ]);
  });
});
