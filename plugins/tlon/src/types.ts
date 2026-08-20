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
  accountVersion?: string;
  kind: "dm" | "channel";
  target: string;
  replyTo?: string;
  parentAuthor?: string;
}

export interface Delivery {
  id: string;
  destination: { type: string; target: string };
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
  createdAt: number;
  claimToken?: string;
}

export interface IncomingAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
  sourceId?: string;
  author?: string;
}

export interface OutgoingAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
  artifactId?: string;
  artifactViewerId?: string;
}

export interface InboundMessage {
  accountId: string;
  installationVersion: string;
  principalId: string;
  messageId: string;
  senderShip: string;
  text: string;
  content?: unknown;
  blob?: string;
  attachments?: IncomingAttachment[];
  inboundNotes?: string[];
  kind: "dm" | "channel";
  target: string;
  threadRoot?: string;
  parentAuthor?: string;
}

export interface InboundRecord {
  id: string;
  message: InboundMessage;
  previousId?: string;
  createdAt: number;
  claimToken: string;
}

export interface RunPresence {
  runId: string;
  accountId: string;
  accountVersion: string;
  conversationId: string;
  status: "pending" | "running" | "done" | "failed";
  activeTools: string[];
}
