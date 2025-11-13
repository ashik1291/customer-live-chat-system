package com.example.chat.controller;

import com.example.chat.domain.ChatMessage;
import com.example.chat.domain.ChatMessageType;
import com.example.chat.domain.ChatParticipant;
import com.example.chat.domain.ConversationMetadata;
import com.example.chat.domain.ParticipantType;
import com.example.chat.dto.CreateConversationRequest;
import com.example.chat.dto.QueueStatusResponse;
import com.example.chat.dto.SendMessageRequest;
import com.example.chat.service.AgentQueueService;
import com.example.chat.service.ConversationService;
import com.example.chat.service.ParticipantIdentityService;
import jakarta.validation.Valid;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/conversations")
public class ConversationController {

    private final ConversationService conversationService;
    private final AgentQueueService agentQueueService;
    private final ParticipantIdentityService participantIdentityService;

    public ConversationController(
            ConversationService conversationService,
            AgentQueueService agentQueueService,
            ParticipantIdentityService participantIdentityService) {
        this.conversationService = conversationService;
        this.agentQueueService = agentQueueService;
        this.participantIdentityService = participantIdentityService;
    }

    @PostMapping
    public ResponseEntity<ConversationMetadata> createConversation(
            @Valid @RequestBody CreateConversationRequest request,
            @RequestHeader(name = "X-Participant-Id", required = false) String participantId,
            @RequestHeader(name = "X-Participant-Name", required = false) String participantName,
            @RequestHeader(name = "X-Auth-Token", required = false) String token,
            @RequestHeader(name = "X-Device-Fingerprint", required = false) String fingerprint) {
        String resolvedId = StringUtils.hasText(participantId) ? participantId : token;

        String resolvedName = participantName;
        if (!StringUtils.hasText(resolvedName)) {
            Object displayName = request.getAttributes().get("displayName");
            if (displayName instanceof String name && StringUtils.hasText(name)) {
                resolvedName = name;
            }
        }

        ChatParticipant participant = participantIdentityService.resolveCustomer(
                resolvedId, fingerprint, resolvedName, request.getAttributes());
        ConversationMetadata conversation = conversationService.startConversation(participant, request.getAttributes());
        return ResponseEntity.ok(conversation);
    }

    @PostMapping("/{conversationId}/queue")
    public ResponseEntity<QueueStatusResponse> requestAgent(
            @PathVariable String conversationId,
            @RequestBody(required = false) Map<String, Object> payload) {
        ConversationMetadata conversation = conversationService
                .getConversation(conversationId)
                .orElseThrow(() -> new IllegalArgumentException("Conversation not found"));
        String channel = payload != null
                ? (String) payload.getOrDefault("channel", "web")
                : "web";
        conversationService.queueForAgent(conversation, channel);
        long position = agentQueueService.position(conversationId);
        return ResponseEntity.ok(QueueStatusResponse.builder()
                .position(position)
                .estimatedWait(Duration.ofMinutes(position * 2L))
                .build());
    }

    @GetMapping("/{conversationId}/messages")
    public ResponseEntity<List<ChatMessage>> getMessages(@PathVariable String conversationId) {
        return ResponseEntity.ok(conversationService.getRecentMessages(conversationId, 100));
    }

    @PostMapping("/{conversationId}/messages")
    public ResponseEntity<ChatMessage> postMessage(
            @PathVariable String conversationId,
            @Valid @RequestBody SendMessageRequest request) {
        ParticipantType participantType;
        try {
            String senderTypeValue = request.getSenderType();
            if (!StringUtils.hasText(senderTypeValue)) {
                senderTypeValue = ParticipantType.CUSTOMER.name();
            }
            participantType = ParticipantType.valueOf(senderTypeValue.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("Unsupported sender type: " + request.getSenderType());
        }

        ChatParticipant sender = participantIdentityService.resolveParticipant(
                request.getSenderId(), participantType, request.getSenderDisplayName(), request.getMetadata());
        ChatMessageType type = StringUtils.hasText(request.getType())
                ? ChatMessageType.valueOf(request.getType().toUpperCase())
                : ChatMessageType.TEXT;
        ChatMessage message = conversationService.sendMessage(conversationId, sender, request.getContent(), type);
        return ResponseEntity.ok(message);
    }

    @DeleteMapping("/{conversationId}")
    public ResponseEntity<ConversationMetadata> customerCloseConversation(
            @PathVariable String conversationId, @RequestHeader(name = "X-Participant-Id") String customerId) {
        if (!StringUtils.hasText(customerId)) {
            throw new IllegalArgumentException("Customer identifier is required to close a conversation");
        }

        ChatParticipant customer = participantIdentityService.resolveCustomer(customerId, null, null, Map.of());
        ConversationMetadata conversation = conversationService.closeConversation(conversationId, customer);
        return ResponseEntity.ok(conversation);
    }
}

