export interface Installation {
  id: string;
  principalId: string;
  ship: string;
  url: string;
  code: string;
  ownerShip: string;
  channels: string[];
  respondWithoutMention: boolean;
  version: string;
}

export interface DeliveryTarget {
  accountId: string;
  kind: "dm" | "channel";
  target: string;
  replyTo?: string;
  parentAuthor?: string;
}

export interface Delivery {
  id: string;
  destination: { type: string; target: string };
  text: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface InboundMessage {
  accountId: string;
  principalId: string;
  messageId: string;
  senderShip: string;
  text: string;
  kind: "dm" | "channel";
  target: string;
  threadRoot: string;
  parentAuthor?: string;
}
