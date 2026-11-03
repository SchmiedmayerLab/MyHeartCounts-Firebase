// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
import { createTransport } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {
  getFeedbackCoordinatorEmail,
  getFeedbackSenderEmail,
  getSmtpHost,
  getSmtpPassword,
  getSmtpPort,
  getSmtpUsername,
} from "../env.js";

export interface CoordinatorMail {
  subject: string;
  text: string;
}

// Sends to the study coordinator mailbox that also receives participant
// feedback. Resolves to false instead of throwing so callers never fail their
// own work over a mail problem.
export const sendCoordinatorMail = async (
  mail: CoordinatorMail,
): Promise<boolean> => {
  const host = getSmtpHost();
  const recipient = getFeedbackCoordinatorEmail();
  if (!host || !recipient) {
    logger.warn(
      `Coordinator mail "${mail.subject}" not sent: SMTP host or coordinator email not configured`,
    );
    return false;
  }

  try {
    // requireTLS/forceAuth make the transport fail loudly if the server does
    // not offer STARTTLS or AUTH, instead of silently sending
    // unauthenticated. forceAuth is supported by nodemailer at runtime but
    // missing from @types/nodemailer, so the options object needs a cast.
    const port = Number(getSmtpPort());
    const transporter = createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: true,
      forceAuth: true,
      logger: true,
      auth: {
        user: getSmtpUsername(),
        pass: getSmtpPassword(),
      },
    } as SMTPTransport.Options);

    await transporter.sendMail({
      from: `"MyHeart Counts" <${getFeedbackSenderEmail()}>`,
      to: recipient,
      subject: mail.subject,
      text: mail.text,
    });

    logger.info(`Coordinator mail "${mail.subject}" sent to ${recipient}`);
    return true;
  } catch (error) {
    logger.error(
      `Failed to send coordinator mail "${mail.subject}": ${String(error)}`,
    );
    return false;
  }
};
