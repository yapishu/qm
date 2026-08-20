export interface Installation {
  id: string;
  principalId: string;
  ship: string;
  url: string;
  code: string;
  ownerShip: string;
  channels: string[];
  respondWithoutMention: boolean;
  ownerVerified: boolean;
  sharedChannelsEnabled: boolean;
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
  destination: {
    type: string;
    target: string;
    scopeVersion?: string;
    approvalRequests?: ApprovalRequest[];
  };
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
  createdAt: number;
  claimToken?: string;
  connectorRef: number;
}

export interface ApprovalRequest {
  requestId: string;
  controlId?: string;
  command: string;
  reason: string;
  purpose?: string;
  summary?: string;
  grantModes?: { session: boolean; always: boolean };
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
  externalPromptData?: Array<{ source: string; content: string }>;
  kind: "dm" | "channel";
  target: string;
  threadRoot?: string;
  parentAuthor?: string;
  scopeVersion?: string;
}

export interface InboundRecord {
  id: string;
  queueKey: string;
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
  scopeVersion?: string;
}
