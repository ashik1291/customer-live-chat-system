## Flutter Mobile Integration Guide (Android/iOS)

This guide explains how to integrate the live chat backend into a Flutter app. It mirrors the web integration using REST for session management/history and Socket.IO for realtime updates.

- REST API base: `https://<backend-host>:8383`
- Socket.IO: `wss://<backend-host>:9094`

Packages (recommended):
- REST: `dio` (or `http`)
- Socket.IO: `socket_io_client: ^2.x`
- Storage: `shared_preferences` (for fingerprint/customerId)

### 1) Data Models (Dart)

```dart
class ConversationMetadata {
  final String id;
  final String status; // QUEUED | ASSIGNED | CONNECTED | CLOSED
  final Participant? customer;
  final Participant? agent;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  ConversationMetadata({required this.id, required this.status, this.customer, this.agent, this.createdAt, this.updatedAt});
  factory ConversationMetadata.fromJson(Map<String, dynamic> j) => ConversationMetadata(
    id: j['id'], status: j['status'],
    customer: j['customer'] != null ? Participant.fromJson(j['customer']) : null,
    agent: j['agent'] != null ? Participant.fromJson(j['agent']) : null,
    createdAt: j['createdAt'] != null ? DateTime.parse(j['createdAt']) : null,
    updatedAt: j['updatedAt'] != null ? DateTime.parse(j['updatedAt']) : null,
  );
}

class Participant {
  final String id;
  final String? displayName;
  Participant({required this.id, this.displayName});
  factory Participant.fromJson(Map<String, dynamic> j) => Participant(id: j['id'], displayName: j['displayName']);
}

class ChatMessage {
  final String id;
  final String conversationId;
  final Map<String, dynamic>? sender; // includes id, type
  final String type; // TEXT | SYSTEM
  final String content;
  final DateTime timestamp;
  ChatMessage({required this.id, required this.conversationId, required this.sender, required this.type, required this.content, required this.timestamp});
  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
    id: j['id'], conversationId: j['conversationId'],
    sender: j['sender'] as Map<String, dynamic>?,
    type: j['type'], content: j['content'],
    timestamp: DateTime.parse(j['timestamp']),
  );
}
```

### 2) Customer Session & Queue (REST)

```dart
import 'package:dio/dio.dart';

class ChatApi {
  final Dio _dio;
  ChatApi(String baseUrl, {Map<String, String>? defaultHeaders})
      : _dio = Dio(BaseOptions(
          baseUrl: baseUrl.replaceAll(RegExp(r'/$'), ''),
          headers: defaultHeaders,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 20),
        ));

  Future<ConversationMetadata> createConversation({
    required String fingerprint,
    required String displayName,
    String? contact,
    String? participantId, // optional, becomes X-Participant-Id
  }) async {
    final headers = <String, dynamic>{};
    if (participantId != null && participantId.isNotEmpty) {
      headers['X-Participant-Id'] = participantId;
      headers['X-Participant-Name'] = displayName;
    }
    final resp = await _dio.post(
      '/api/conversations',
      data: {
        'attributes': {'fingerprint': fingerprint, 'displayName': displayName, 'contact': contact}
      },
      options: Options(headers: headers),
    );
    return ConversationMetadata.fromJson(resp.data);
  }

  Future<void> requestAgent(String conversationId, {String channel = 'web'}) async {
    await _dio.post('/api/conversations/$conversationId/queue', data: {'channel': channel});
  }

  Future<List<ChatMessage>> listMessages(String conversationId, {int limit = 100}) async {
    final resp = await _dio.get('/api/conversations/$conversationId/messages', queryParameters: {'limit': limit});
    final list = (resp.data as List).cast<Map<String, dynamic>>();
    return list.map(ChatMessage.fromJson).toList();
  }

  Future<ChatMessage> sendCustomerMessage(String conversationId, {
    required String customerId,
    required String displayName,
    required String content,
    String type = 'TEXT',
  }) async {
    final resp = await _dio.post('/api/conversations/$conversationId/messages', data: {
      'senderId': customerId,
      'senderDisplayName': displayName,
      'senderType': 'CUSTOMER',
      'content': content,
      'type': type,
    });
    return ChatMessage.fromJson(resp.data);
  }

  Future<void> closeConversation(String conversationId, String customerId) async {
    await _dio.delete('/api/conversations/$conversationId', options: Options(headers: {'X-Participant-Id': customerId}));
  }
}
```

### 3) Realtime Messaging (Socket.IO)

```dart
import 'dart:async';
import 'package:socket_io_client/socket_io_client.dart' as IO;

class ChatSocket {
  final String socketBaseUrl;
  IO.Socket? _socket;
  final _handshakeCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _messageCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _errorCtrl = StreamController<String>.broadcast();
  final _disconnectCtrl = StreamController<void>.broadcast();

  ChatSocket(this.socketBaseUrl);

  Stream<Map<String, dynamic>> get handshake$ => _handshakeCtrl.stream;
  Stream<Map<String, dynamic>> get messages$ => _messageCtrl.stream;
  Stream<String> get errors$ => _errorCtrl.stream;
  Stream<void> get disconnect$ => _disconnectCtrl.stream;

  void connectCustomer({
    required String conversationId,
    required String customerId,
    required String fingerprint,
    String? displayName,
  }) {
    disconnect();
    final q = {
      'role': 'customer',
      'token': customerId,
      'displayName': displayName ?? '',
      'conversationId': conversationId,
      'fingerprint': fingerprint,
    };
    _socket = IO.io(
      socketBaseUrl.replaceAll(RegExp(r'/$'), ''),
      IO.OptionBuilder()
          .setTransports(['websocket'])
          .setQuery(q)
          .enableAutoConnect()
          .build(),
    );
    _registerCommonHandlers();
  }

  Future<Map<String, dynamic>> sendMessage({
    required String conversationId,
    required String content,
    String type = 'TEXT',
  }) {
    final c = Completer<Map<String, dynamic>>();
    final s = _socket;
    if (s == null || s.disconnected) {
      c.completeError(StateError('Socket not connected'));
      return c.future;
    }
    s.emitWithAck('chat:message', {'conversationId': conversationId, 'content': content, 'type': type},
        ack: (data) {
      if (data is Map && data.containsKey('error')) {
        c.completeError(StateError(data['error'] as String? ?? 'Failed to send'));
      } else {
        c.complete((data as Map).cast<String, dynamic>());
      }
    });
    return c.future;
  }

  void _registerCommonHandlers() {
    final s = _socket!;
    s.on('connect_error', (err) => _errorCtrl.add((err?.toString() ?? 'connect_error')));
    s.on('system:event', (payload) => _handshakeCtrl.add((payload as Map).cast<String, dynamic>()));
    s.on('chat:message', (payload) => _messageCtrl.add((payload as Map).cast<String, dynamic>()));
    s.on('system:error', (payload) => _errorCtrl.add(((payload as Map)['message'] as String?) ?? 'socket error'));
    s.on('disconnect', (_) => _disconnectCtrl.add(null));
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
  }

  void dispose() {
    disconnect();
    _handshakeCtrl.close();
    _messageCtrl.close();
    _errorCtrl.close();
    _disconnectCtrl.close();
  }
}
```

### 4) Typical Flow in Flutter

1. Generate or restore `customerId` and `fingerprint` with `shared_preferences`.
2. `createConversation(...)` → store `conversationId` locally.
3. `requestAgent(conversationId)` to join the queue.
4. Open Socket.IO with `connectCustomer(...)` for realtime events; subscribe to `handshake$` and `messages$`.
5. Show message history using `listMessages(conversationId)` (Redis tail).
6. Send messages via `sendMessage(...)` or via REST `sendCustomerMessage(...)` (optional fallback).
7. Handle `system:event` status changes: `ASSIGNED`, `CLOSED` to update UI.
8. On dispose/background, keep socket connected if allowed; otherwise, disconnect and reconnect on resume.

### 5) Reconnect & Offline Handling

- Enable Socket.IO automatic reconnect (default). On `disconnect`, trigger:
  - Exponential backoff reconnect (built-in). 
  - After reconnect, re-emit the same query (Socket.IO does this), then call `listMessages` to fill gaps.
- For transient REST errors, retry with backoff (e.g., Dio’s interceptor) and timeouts.
- Cache `customerId`, `conversationId`, `displayName`, and `fingerprint` locally.

### 6) Security & Headers

- If your deployment uses JWT/API keys, add `Authorization: Bearer <token>` to both Dio and Socket.IO (e.g., via query or extra headers if behind a gateway).
- Always validate content length and sanitize before rendering.
- Respect backend rate limits (message throttling).

### 7) Agent App (Optional, for staff app)

- REST:
  - `GET /api/agent/queue?page=0&size=20`
  - `POST /api/agent/conversations/{id}/accept` (body: `{agentId, displayName}`)
  - `GET /api/agent/conversations?status=ASSIGNED,CONNECTED`
  - `GET /api/agent/conversations/{id}/messages?limit=100`
  - `POST /api/agent/conversations/{id}/close`
- Socket.IO queue stream:
  - Connect with query `{ role:'agent', token:'<agentId>', displayName:'<name>', scope:'queue' }`.
  - Listen for `queue:snapshot` and update the UI.
- Per-conversation sockets:
  - Connect with `{ role:'agent', token:'<agentId>', conversationId:'<id>', displayName:'<name>' }`.
  - Use `chat:message` for realtime messaging.

### 8) Testing Checklist

- Start/Resume conversation across app restarts (IDs restored).
- Queue request, live assignment update via `system:event`.
- Bi-directional messaging works with airplane mode toggles (reconnect catches up via history).
- Closing conversation updates UI and prevents further sends.
- Backoff and retry paths visible in logs.

### 9) Troubleshooting

- Socket fails to connect: verify `wss://<host>:9094`, TLS, and query params (`role`, `token`, `conversationId`, `fingerprint` for customer; `scope=queue` for agent queue).
- REST errors 401/403: attach correct auth headers in Dio.
- Messages missing: fetch last messages via REST after reconnect.


