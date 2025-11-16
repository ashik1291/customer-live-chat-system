# Customer Live Chat Backend Architecture

## High-Level Overview

- **Backend Service (Spring Boot)** – Exposes REST for lifecycle/snapshots and hosts the Socket.IO gateway for realtime messaging and queue streaming.
- **Conversation Service** – Orchestrates conversation lifecycle: start, queue, accept, message, close. Uses Redisson for distributed locks and Redis for ephemeral state.
- **Redis (ephemeral source of truth)** – Stores queue, assignments, presence, and message buffers. Operations are atomic via Redisson.
- **PostgreSQL (metadata only)** – Persists `ConversationMetadata` for reporting and durability of non-ephemeral info (ids, participants, timestamps, status).
- **Kafka (analytics/event streaming)** – Asynchronously publishes lifecycle (`chat.lifecycle`) and message (`chat.messages`) events for BI, monitoring, or downstream processors.
- **Pluggable Interfaces** – `ChatAuthenticationProvider`, `ChatEventListener`, and repository abstractions allow host apps to customize authentication, event handling, and storage.

## Runtime Data Model (Redis Keys)

- `lc:conversation:{conversationId}:messages` – list of `ChatMessage` (JSON), TTL-bound.
- `lc:queue:pending` – scored-sorted-set of conversation ids by `enqueuedAt`.
- `lc:queue:entries` – map conversationId → `QueueEntry` (customer id, name, phone, channel, enqueuedAt).
- `lc:presence:{participantId}` – last-seen timestamp (expiring).
- `lc:assignment:{conversationId}` – bucket with current agent owner (TTL refreshed while active).
- Locks: `lock:conversation:{conversationId}` and `lock:queue` for atomic lifecycle transitions.

## Ingress & Events

- REST (examples): `/api/conversations`, `/api/conversations/{id}/queue`, `/api/conversations/{id}/messages`, `/api/agent/queue`, `/api/agent/conversations/{id}/accept`, `/api/agent/conversations/{id}/close`.
- Socket.IO:
  - Customer/Agent conversation stream: `system:event`, `chat:message` per conversation room.
  - Agent queue stream: `queue:snapshot` via special `scope=queue` connection.
- Kafka topics:
  - `chat.lifecycle`: `CONVERSATION_STARTED`, `CONVERSATION_QUEUED`, `CONVERSATION_ACCEPTED`, `MESSAGE_RECEIVED`, `CONVERSATION_CLOSED`.
  - `chat.messages`: full message payloads for analytics/auditing (non-blocking).

## Core Flows

1. **Start conversation**
   - REST creates metadata (PostgreSQL), marks presence (Redis), emits `CONVERSATION_STARTED` (Kafka).
   - If using Socket.IO without `conversationId`, backend creates one and joins the room.

2. **Queue for agent**
   - REST triggers `queueForAgent`. Under `lock:conversation:{id}`, status set to `QUEUED`, previous assignment (if any) released, queue entry added to Redis.
   - Queue snapshot published to agents via Redis Pub/Sub → Socket.IO `queue:snapshot`.

3. **Accept conversation (single winner)**
   - Agent calls REST `accept`. Under `lock:conversation:{id}`, service uses Redis assignment bucket + queue claim to atomically grant ownership or return conflict.
   - On success: status `ASSIGNED` (PostgreSQL), assignment TTL set, queue entry removed, emit `CONVERSATION_ACCEPTED` (Kafka), notify via `system:event` to customer and agents.

4. **Messaging (ephemeral)**
   - Socket.IO `chat:message` or REST message endpoint calls `sendMessage` under `lock:conversation:{id}`.
   - Append to Redis message list, update timestamps/presence, emit `chat.messages` and `MESSAGE_RECEIVED` (Kafka), broadcast to room on `chat:message`.

5. **Close conversation**
   - Agent/customer triggers close. Under lock: write system message to Redis, set status `CLOSED` (PostgreSQL), remove queue/assignment keys, emit `CONVERSATION_CLOSED` (Kafka), notify UIs via `system:event`.

6. **Reconnect & snapshots**
   - Clients reconnect Socket.IO with `conversationId` (and role). Backend rejoins room and pushes state; clients may call REST to fetch recent Redis messages to cover gaps.

## Resilience & Scalability

- **Horizontal scale** – Multiple service instances share Redis/Kafka. Socket.IO rooms are node-local; fan-out is handled by publishing events to all instances which then broadcast to their connected clients.
- **Locks & idempotency** – Redisson locks per conversation/queue enforce single-winner acceptance and consistent transitions. Assignment buckets/TTLs prevent stale ownership.
- **TTL & cleanup** – Presence and message lists honor TTLs to avoid leaks. Queue purge is periodic and snapshot broadcasts keep agent UIs consistent.
- **Failure modes** – If Pub/Sub is delayed, UIs fall back to REST polling. Kafka is best-effort and does not block user actions.

## Security

- Terminate TLS and prefer secure WebSocket transports in production.
- Integrate with Spring Security or upstream gateways; validate `Authorization` on REST and pass identity via Socket.IO query/headers.
- Apply server-side message rate limits and validate content to protect UIs.

## Configuration

- `chat.redis.*`: key prefixes, TTLs, locks.
- `chat.queue.*`: broadcast limits, purge thresholds, per-agent concurrency.
- `chat.socket.*`: host/port, CORS, transports.
- `chat.security.*`: auth providers, headers, allowed origins.

