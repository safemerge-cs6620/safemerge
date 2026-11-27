import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

export const LEASE_SECONDS = 120;
const DAY = 86400;

export function makeStore({ table, bucket, ddb, s3 }) {
  ddb = ddb || DynamoDBDocumentClient.from(new DynamoDBClient({}));
  s3 = s3 || new S3Client({});
  const now = () => Math.floor(Date.now() / 1000);
  return {
    async claimDelivery(deliveryId, t = now()) {
      try {
        const r = await ddb.send(new UpdateCommand({
          TableName: table,
          Key: { repo: "delivery", scanKey: deliveryId },
          UpdateExpression: "SET #state = :processing, leaseUntil = :lease, scanId = if_not_exists(scanId, :sid), scanTime = if_not_exists(scanTime, :st), #ttl = if_not_exists(#ttl, :ttl)",
          ConditionExpression: "attribute_not_exists(scanKey) OR (#state = :processing AND leaseUntil < :now)",
          ExpressionAttributeNames: { "#state": "state", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":processing": "processing", ":lease": t + LEASE_SECONDS, ":now": t,
            ":sid": randomUUID(), ":st": new Date(t * 1000).toISOString(), ":ttl": t + 7 * DAY,
          },
          ReturnValues: "ALL_NEW",
        }));
        return { claimed: true, scanId: r.Attributes.scanId, scanTime: r.Attributes.scanTime };
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return { claimed: false };
        throw e;
      }
    },
    async markDone(deliveryId) {
      await ddb.send(new UpdateCommand({
        TableName: table, Key: { repo: "delivery", scanKey: deliveryId },
        UpdateExpression: "SET #state = :done", ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":done": "done" },
      }));
    },
    async putScan(item) { await ddb.send(new PutCommand({ TableName: table, Item: item })); },
    async putReport(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(body), ContentType: "application/json" }));
    },
  };
}
