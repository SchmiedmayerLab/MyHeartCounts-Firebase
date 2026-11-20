// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { type FHIRQuestionnaireResponse } from "../../../models/index.js";
import { FirestoreService } from "../../../services/database/firestoreService.js";
import {
  ParQPlusClearanceQuestionnaireResponseService,
  parQPlusGeneralQuestionLinkIds,
} from "../../../services/questionnaireResponse/parQPlusClearanceService.js";
import {
  authoredAt,
  groveQuestionnaireResponse,
  preGroveQuestionnaireResponse,
  questionnaireResponseDocument,
  testUserId,
} from "../../helpers/questionnaireResponses.js";
import { MockFirestore } from "../../mocks/firestore.js";

const heartConditionLinkId = parQPlusGeneralQuestionLinkIds[0];
const heartFollowUpLinkId = "6ab1cdf1-f8fa-429b-ba08-7097a87ffb82"; // heart or cardiovascular condition
const heartFailureLinkId = "c59933b4-153b-4067-88e8-327075dbd22c"; // chronic heart failure

const booleanItem = (linkId: string, value: boolean) => ({
  linkId,
  answer: [{ valueBoolean: value }],
});

const generalItems = (overrides: Record<string, boolean> = {}) =>
  parQPlusGeneralQuestionLinkIds.map((linkId) =>
    booleanItem(linkId, overrides[linkId] ?? false),
  );

const setup = async (userData: Record<string, unknown> = {}) => {
  const databaseService = new FirestoreService(
    new MockFirestore() as unknown as Firestore,
  );
  await databaseService.runTransaction((collections, transaction) => {
    transaction.set(
      collections.firestore.collection("users").doc(testUserId),
      userData,
    );
  });
  const service = new ParQPlusClearanceQuestionnaireResponseService({
    databaseService,
  });
  const userDoc = async () =>
    (
      await databaseService.getDocument((collections) =>
        collections.firestore.collection("users").doc(testUserId),
      )
    )?.content as Record<string, unknown>;
  return { databaseService, service, userDoc };
};

const handle = (
  service: ParQPlusClearanceQuestionnaireResponseService,
  id: string,
  content: FHIRQuestionnaireResponse,
) =>
  service.handle(testUserId, questionnaireResponseDocument(id, content), {
    isNew: true,
  });

describe("ParQPlusClearanceQuestionnaireResponseService", () => {
  it("ignores other questionnaires", async () => {
    const { service, userDoc } = await setup();
    const handled = await handle(
      service,
      "r1",
      groveQuestionnaireResponse("who5", "r1", generalItems()),
    );
    expect(handled).to.equal(false);
    expect(await userDoc()).to.deep.equal({});
  });

  it("clears a Grove response with all general questions answered no", async () => {
    const { service, userDoc } = await setup();
    const handled = await handle(
      service,
      "r1",
      groveQuestionnaireResponse("parQplus", "r1", generalItems()),
    );
    expect(handled).to.equal(true);
    const user = await userDoc();
    expect(user.parQPlusCleared).to.equal(true);
    expect(
      (user.parQPlusAuthored as Timestamp).toDate().toISOString(),
    ).to.equal(authoredAt.toISOString());
  });

  it("clears a pre-Grove response with a general yes but every follow-up answered no", async () => {
    const { service, userDoc } = await setup();
    const handled = await handle(
      service,
      "r1",
      preGroveQuestionnaireResponse("parQplus", "r1", [
        ...generalItems({ [heartConditionLinkId]: true }),
        booleanItem(heartFollowUpLinkId, false),
      ]),
    );
    expect(handled).to.equal(true);
    expect((await userDoc()).parQPlusCleared).to.equal(true);
  });

  it("does not clear when a follow-up condition question is answered yes", async () => {
    const { service, userDoc } = await setup();
    await handle(
      service,
      "r1",
      groveQuestionnaireResponse("parQplus", "r1", [
        ...generalItems({ [heartConditionLinkId]: true }),
        booleanItem(heartFollowUpLinkId, true),
        booleanItem(heartFailureLinkId, true),
      ]),
    );
    expect((await userDoc()).parQPlusCleared).to.equal(false);
  });

  it("leaves the flag alone when a general question is unanswered", async () => {
    const { service, userDoc } = await setup({ parQPlusCleared: false });
    const handled = await handle(
      service,
      "r1",
      groveQuestionnaireResponse("parQplus", "r1", generalItems().slice(1)),
    );
    expect(handled).to.equal(false);
    expect(await userDoc()).to.deep.equal({ parQPlusCleared: false });
  });

  it("keeps the newer answer when an older response arrives later", async () => {
    const { service, userDoc } = await setup({
      parQPlusCleared: false,
      parQPlusAuthored: Timestamp.fromDate(new Date("2026-09-01T00:00:00Z")),
    });
    const handled = await handle(
      service,
      "r1",
      preGroveQuestionnaireResponse("parQplus", "r1", generalItems()),
    );
    expect(handled).to.equal(true);
    expect((await userDoc()).parQPlusCleared).to.equal(false);
  });

  it("overwrites an older stored answer with a newer response", async () => {
    const { service, userDoc } = await setup({
      parQPlusCleared: false,
      parQPlusAuthored: Timestamp.fromDate(new Date("2026-01-01T00:00:00Z")),
    });
    await handle(
      service,
      "r1",
      preGroveQuestionnaireResponse("parQplus", "r1", generalItems()),
    );
    expect((await userDoc()).parQPlusCleared).to.equal(true);
  });
});
