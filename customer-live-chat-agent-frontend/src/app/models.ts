export interface ChatParticipant {
  id: string;
  type: 'CUSTOMER' | 'AGENT' | 'SYSTEM' | string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export type ConversationStatus = 'OPEN' | 'QUEUED' | 'ASSIGNED' | 'CLOSED';

export interface ConversationMetadata {
  id: string;
  status: ConversationStatus;
  customer?: ChatParticipant | null;
  agent?: ChatParticipant | null;
  createdAt?: string;
  updatedAt?: string;
  acceptedAt?: string;
  closedAt?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  type: string;
  sender?: ChatParticipant | null;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface QueueEntry {
  conversationId: string;
  enqueuedAt?: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  channel?: string;
}

export interface AgentAcceptRequest {
  agentId: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentActionRequest {
  agentId?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface SocketHandshake {
  participant: ChatParticipant;
  conversation: ConversationMetadata;
}

