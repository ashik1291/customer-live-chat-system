# Customer Support Live Chat System

A production-ready live chat platform composed of three applications:
- `customer-live-chat` – Spring Boot backend with PostgreSQL, Redis/Redisson, Socket.IO, and Kafka.
- `customer-live-chat-agent-frontend` – Angular dashboard for support agents.
- `customer-live-chat-customer-frontend` – Angular widget embedded in customer-facing sites.

## Prerequisites
- Java 21+, Node.js 18+, npm 9+
- PostgreSQL 15+ and Redis 7+ running and reachable
- Kafka 3.x cluster (for lifecycle/message streams)

## Backend (`customer-live-chat`)
```bash
cd customer-live-chat
cp src/main/resources/application.yml.example src/main/resources/application.yml
# adjust DB, Redis, Kafka, Socket.IO settings
./gradlew bootRun
```

Key ports:
- REST API: `http://localhost:8383`
- Socket.IO: `ws://localhost:9094`

Core features:
- Conversation metadata stored in PostgreSQL with optimistic locking
- Queue state, session bindings, and distributed locks via Redisson
- Queue snapshots broadcast through Redis Pub/Sub to Socket.IO
- Chat lifecycle/message events published to Kafka topics

## Agent Frontend (`customer-live-chat-agent-frontend`)
```bash
cd customer-live-chat-agent-frontend
npm install
npm run start
```
- Served on `http://localhost:4201`
- Proxies API/WebSocket calls to backend (configured in `proxy.conf.json`)
- Handles up to three concurrent chat widgets, realtime queue updates, conflict/error handling

## Customer Frontend (`customer-live-chat-customer-frontend`)
```bash
cd customer-live-chat-customer-frontend
npm install
npm run start
```
- Served on `http://localhost:4200`
- Embeddable widget with pre-chat form, auto-scroll, send-on-enter, manual close, and reconnect support

## Production Notes
- Externalize configuration with environment variables or Spring Config Server
- Secure CORS and rate limiting (`ChatSecurityProperties`)
- Run PostgreSQL/Redis/Kafka in HA mode; enable Redis persistence if required
- Use `./gradlew check` and `npm run build` before deploying
- Monitor metrics (queue size, WebSocket connections, Kafka publish results) via your APM stack

## License
Proprietary – contact the owner for usage permissions.
