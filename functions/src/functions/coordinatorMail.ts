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
    // requireTLS/forceAuth fail loudly instead of sending unauthenticated;
    // forceAuth is missing from @types/nodemailer, hence the cast.
    const port = Number(getSmtpPort());
    const transporter = createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: true,
      forceAuth: true,
      logger: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
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
