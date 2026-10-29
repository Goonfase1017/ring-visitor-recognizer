import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { CONFIG } from "./config";

const hasCredentials = Boolean(CONFIG.AWS_ACCESS_KEY_ID && CONFIG.AWS_SECRET_ACCESS_KEY);
const topicRegion = CONFIG.AWS_SNS_TOPIC_ARN.match(/^arn:aws(?:-us-gov|-cn)?:sns:([^:]+):/)?.[1];
const clientRegion = topicRegion ?? CONFIG.AWS_DEFAULT_REGION;
const client = new SNSClient({
  region: clientRegion,
  ...(hasCredentials
    ? {
        credentials: {
          accessKeyId: CONFIG.AWS_ACCESS_KEY_ID,
          secretAccessKey: CONFIG.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

/** Publish a JSON payload to the configured SNS topic. */
export async function publishNotification(payload: any) {
  if (!CONFIG.AWS_SNS_TOPIC_ARN) {
    console.warn("SNS notification skipped: AWS_SNS_TOPIC_ARN is not configured");
    return null;
  }

  const command = new PublishCommand({
    TopicArn: CONFIG.AWS_SNS_TOPIC_ARN,
    Message: JSON.stringify(payload),
    MessageAttributes: {
      eventType: {
        DataType: "String",
        StringValue: payload.type ?? "unknown",
      },
    },
  });
  let topicResponse: any = null;
  if (CONFIG.AWS_SNS_TOPIC_ARN) {
    try {
      topicResponse = await client.send(command);
      console.log("SNS topic notification sent, MessageId", topicResponse.MessageId);
    } catch (err) {
      console.error("Failed to send SNS topic notification", err);
    }
  }

  if (CONFIG.VISITOR_SMS_PHONE) {
    try {
      const normalizedPhone = CONFIG.VISITOR_SMS_PHONE.startsWith("+")
        ? CONFIG.VISITOR_SMS_PHONE
        : `+${CONFIG.VISITOR_SMS_PHONE}`;
      const smsMessage = payload.message ?? "A visitor has arrived. Review the dashboard for details and photos.";
      const smsResponse = await client.send(new PublishCommand({
        PhoneNumber: normalizedPhone,
        Message: smsMessage,
      }));
      console.log("SMS visitor notification sent, MessageId", smsResponse.MessageId);
    } catch (err) {
      console.error("Failed to send SMS visitor notification", err);
    }
  } else {
    console.log("SMS notification skipped: VISITOR_SMS_PHONE is not configured");
  }

  return topicResponse;
}
