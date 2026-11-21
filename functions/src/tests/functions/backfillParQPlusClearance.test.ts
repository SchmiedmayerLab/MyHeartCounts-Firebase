// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { backfillParQPlusClearance } from "../../functions/backfillParQPlusClearance.js";
import { FirestoreService } from "../../services/database/firestoreService.js";
import { parQPlusGeneralQuestionLinkIds } from "../../services/questionnaireResponse/parQPlusClearanceService.js";
import {
  booleanItem,
  groveQuestionnaireResponse,
  parQPlusGeneralItems,
  parQPlusHeartFailureLinkId,
  parQPlusHeartFollowUpLinkId,
  preGroveQuestionnaireResponse,
} from "../helpers/questionnaireResponses.js";
import { MockFirestore } from "../mocks/firestore.js";

describe("backfillParQPlusClearance", () => {
  it("computes the flag from the newest Par-Q+ response and skips flagged users", async () => {
    const databaseService = new FirestoreService(
      new MockFirestore() as unknown as Firestore,
    );
    await databaseService.runTransaction((collections, transaction) => {
      const users = collections.firestore.collection("users");
      transaction.set(users.doc("answered"), {});
      transaction.set(users.doc("never-answered"), {});
      transaction.set(users.doc("already-flagged"), {
        parQPlusCleared: false,
        parQPlusAuthored: Timestamp.fromDate(new Date("2026-10-01T00:00:00Z")),
      });
      const responses = collections.userQuestionnaireResponses("answered");
      // Older pre-Grove response says "no" everywhere, newer Grove one has a general "yes" and follow-up "yes".
      transaction.set(
        responses.doc("old"),
        preGroveQuestionnaireResponse(
          "parQplus",
          "old",
          parQPlusGeneralItems(),
          new Date("2026-01-01T00:00:00Z"),
        ),
      );
      transaction.set(
        responses.doc("new"),
        groveQuestionnaireResponse("parQplus", "new", [
          ...parQPlusGeneralItems({
            [parQPlusGeneralQuestionLinkIds[0]]: true,
          }),
          booleanItem(parQPlusHeartFollowUpLinkId, true),
          booleanItem(parQPlusHeartFailureLinkId, true),
        ]),
      );
      transaction.set(
        collections.userQuestionnaireResponses("already-flagged").doc("r"),
        preGroveQuestionnaireResponse("parQplus", "r", parQPlusGeneralItems()),
      );
    });

    await backfillParQPlusClearance(databaseService);

    const user = async (id: string) =>
      (
        await databaseService.getDocument((collections) =>
          collections.firestore.collection("users").doc(id),
        )
      )?.content as Record<string, unknown>;

    expect((await user("answered")).parQPlusCleared).to.equal(false);
    expect(await user("never-answered")).to.deep.equal({});
    expect((await user("already-flagged")).parQPlusCleared).to.equal(false);
  });
});
