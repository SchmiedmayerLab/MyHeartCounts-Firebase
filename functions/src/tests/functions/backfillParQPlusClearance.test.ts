// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { backfillParQPlusClearance } from "../../functions/backfillParQPlusClearance.js";
import { FirestoreService } from "../../services/database/firestoreService.js";
import {
  parQPlusGeneralQuestionLinkIds,
  parQPlusQuestionnaireUrl,
} from "../../services/questionnaireResponse/parQPlusClearanceService.js";
import {
  authoredAt,
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
      // Newer Grove response has a general "yes" and follow-up "yes"; the older pre-Grove one says "no" everywhere.
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
        responses.doc("old"),
        preGroveQuestionnaireResponse(
          "parQplus",
          "old",
          parQPlusGeneralItems(),
          new Date("2026-01-01T00:00:00Z"),
        ),
      );
      // Malformed legacy documents must not block the user.
      transaction.set(
        collections.firestore
          .collection("users")
          .doc("answered")
          .collection("questionnaireResponses")
          .doc("broken"),
        { questionnaire: `${parQPlusQuestionnaireUrl}|0.1.0`, item: "nope" },
      );
      transaction.set(
        collections.firestore
          .collection("users")
          .doc("answered")
          .collection("questionnaireResponses")
          .doc("legacy"),
        { foo: "bar" },
      );
      // Newer and cleared, so processing it would flip the stored flag.
      transaction.set(
        collections.userQuestionnaireResponses("already-flagged").doc("r"),
        preGroveQuestionnaireResponse(
          "parQplus",
          "r",
          parQPlusGeneralItems(),
          new Date("2026-11-01T00:00:00Z"),
        ),
      );
    });

    await backfillParQPlusClearance(databaseService);

    const user = async (id: string) =>
      (
        await databaseService.getDocument((collections) =>
          collections.firestore.collection("users").doc(id),
        )
      )?.content as Record<string, unknown>;

    const answered = await user("answered");
    expect(answered.parQPlusCleared).to.equal(false);
    expect(
      (answered.parQPlusAuthored as Timestamp).toDate().toISOString(),
    ).to.equal(authoredAt.toISOString());
    expect(await user("never-answered")).to.deep.equal({});
    expect((await user("already-flagged")).parQPlusCleared).to.equal(false);
  });
});
