// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

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
    expect(
      observation.code.coding?.map((coding) => coding.system),
    ).to.deep.equal([
      CodingSystem.mhcSampleType,
      CodingSystem.mhcSampleTypeSuperseded,
    ]);
    expect(
      observation.code.coding?.every(
        (coding) => coding.code === "MHCCustomSampleTypeNicotineExposure",
      ),
    ).to.be.true;
  });

  it("should write a final observation with a UCUM count quantity", () => {
    expect(observation.status).to.equal(FHIRObservationStatus.final);
    expect(observation.valueQuantity).to.deep.include({
      value: 3,
      unit: "count",
      system: CodingSystem.ucum,
      code: "{count}",
    });
    expect(observation.effectiveDateTime?.toISOString()).to.equal(
      "2026-08-28T15:32:00.000Z",
    );
  });

  it("should name the source revision under the Grove extension url", () => {
    const urls = observation.extension?.map((extension) => extension.url) ?? [];
    expect(urls).to.include(
      "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/version",
    );
    expect(urls).to.include(
      "https://bdh.stanford.edu/fhir/defs/sampleUploadTimeZone",
    );
    expect(
      urls.some((url) =>
        url.includes("bdh.stanford.edu/fhir/defs/sourceRevision"),
      ),
    ).to.be.false;
  });
});
