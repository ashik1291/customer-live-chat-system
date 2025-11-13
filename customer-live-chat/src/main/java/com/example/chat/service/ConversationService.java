package com.example.chat.service;

import com.example.chat.config.ChatProperties;
import com.example.chat.domain.ChatMessage;
import com.example.chat.domain.ChatMessageType;
import com.example.chat.domain.ChatParticipant;
import com.example.chat.domain.ConversationMetadata;
import com.example.chat.domain.ConversationStatus;
import com.example.chat.domain.ParticipantType;
import com.example.chat.domain.QueueEntry;
import com.example.chat.event.ChatEvent;
import com.example.chat.event.ChatEventPublisher;
import com.example.chat.event.ChatEventType;
import com.example.chat.event.ChatMessageEvent;
import java.time.Instant;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
public class ConversationService {

    private final ConversationRepository conversationRepository;
    private final AgentQueueService queueService;
    private final PresenceService presenceService;
    private final AgentAssignmentService agentAssignmentService;
    private final ChatEventPublisher eventPublisher;
    private final ChatProperties chatProperties;
    private final StringRedisTemplate stringRedisTemplate;
    private final RedisKeyFactory keyFactory;

    @Transactional
    public ConversationMetadata startConversation(ChatParticipant customer, Map<String, Object> attributes) {
        Instant now = Instant.now();
        ConversationMetadata conversation = ConversationMetadata.builder()
                .id(UUID.randomUUID().toString())
                .customer(customer)
                .status(ConversationStatus.OPEN)
                .attributes(attributes)
                .createdAt(now)
                .updatedAt(now)
                .build();

        conversationRepository.saveConversation(conversation);
        presenceService.markPresent(customer.getId());

        eventPublisher.publishLifecycleEvent(ChatEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversation.getId())
                .type(ChatEventType.CONVERSATION_STARTED)
                .occurredAt(now)
                .payload(Map.of("customerId", customer.getId()))
                .build());

        return conversation;
    }

    public void queueForAgent(ConversationMetadata conversation, String channel) {
        Instant now = Instant.now();
        conversation.setStatus(ConversationStatus.QUEUED);
        conversation.setUpdatedAt(now);
        ChatParticipant previousAgent = conversation.getAgent();
        if (previousAgent != null) {
            agentAssignmentService.removeAssignment(previousAgent.getId(), conversation.getId());
            conversation.setAgent(null);
        }
        conversationRepository.saveConversation(conversation);
        releaseAssignment(conversation.getId());

        QueueEntry entry = QueueEntry.builder()
                .conversationId(conversation.getId())
                .customerId(conversation.getCustomer().getId())
                .customerName(conversation.getCustomer().getDisplayName())
                .customerPhone(resolveCustomerPhone(conversation))
                .channel(channel)
                .enqueuedAt(now)
                .build();
        queueService.enqueue(entry);

        eventPublisher.publishLifecycleEvent(ChatEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversation.getId())
                .type(ChatEventType.CONVERSATION_QUEUED)
                .occurredAt(now)
                .payload(Map.of("queuePosition", queueService.position(conversation.getId())))
                .build());
    }

    public Optional<ConversationMetadata> getConversation(String conversationId) {
        return conversationRepository.getConversation(conversationId);
    }

    public List<ChatMessage> getRecentMessages(String conversationId, int limit) {
        return conversationRepository.getMessages(conversationId, limit);
    }

    public List<ConversationMetadata> getConversationsForAgent(String agentId, Set<ConversationStatus> statuses) {
        if (!StringUtils.hasText(agentId)) {
            throw new IllegalArgumentException("Agent identifier is required");
        }

        Set<ConversationStatus> filters = statuses == null || statuses.isEmpty() ? Set.of() : Set.copyOf(statuses);

        return conversationRepository.findAll().stream()
                .filter(conversation -> conversation.getAgent() != null)
                .filter(conversation -> agentId.equals(conversation.getAgent().getId()))
                .filter(conversation ->
                        filters.isEmpty() || filters.contains(conversation.getStatus()))
                .sorted((a, b) -> {
                    Instant left = a.getUpdatedAt() != null ? a.getUpdatedAt() : a.getCreatedAt();
                    Instant right = b.getUpdatedAt() != null ? b.getUpdatedAt() : b.getCreatedAt();
                    if (left == null && right == null) {
                        return 0;
                    }
                    if (left == null) {
                        return 1;
                    }
                    if (right == null) {
                        return -1;
                    }
                    return right.compareTo(left);
                })
                .toList();
    }

    public ConversationMetadata acceptConversation(ChatParticipant agent, String conversationId) {
        ConversationMetadata conversation = conversationRepository
                .getConversation(conversationId)
                .orElseThrow(() -> new IllegalArgumentException("Conversation not found"));

        if (conversation.getStatus() == ConversationStatus.CLOSED) {
            throw new IllegalStateException("Conversation already closed");
        }

        if (conversation.getAgent() != null
                && !agent.getId().equals(conversation.getAgent().getId())) {
            throw new IllegalStateException("Conversation already assigned to another agent.");
        }

        boolean alreadyAssignedToAgent = conversation.getAgent() != null
                && agent.getId().equals(conversation.getAgent().getId());

        if (alreadyAssignedToAgent && conversation.getStatus() == ConversationStatus.ASSIGNED) {
            queueService.remove(conversationId);
            extendAssignment(conversationId);
            agentAssignmentService.registerAssignment(agent.getId(), conversationId);
            return conversation;
        }

        if (!alreadyAssignedToAgent && !agentAssignmentService.canAssign(agent.getId())) {
            throw new IllegalStateException("Agent reached maximum concurrent conversations");
        }

        if (conversation.getStatus() != ConversationStatus.QUEUED) {
            releaseAssignment(conversationId);
            throw new IllegalStateException("Conversation is no longer available to accept.");
        }

        AgentQueueService.ClaimResult claimResult = queueService.claimForAgent(
                conversationId, agent.getId(), chatProperties.getRedis().getConversationTtl());
        AgentQueueService.ClaimStatus claimStatus = claimResult.status();

        if (claimStatus == AgentQueueService.ClaimStatus.BUSY) {
            throw new IllegalStateException("Conversation already assigned to another agent.");
        }

        if (claimStatus == AgentQueueService.ClaimStatus.MISSING) {
            releaseAssignment(conversationId);
            throw new IllegalStateException("Conversation already assigned to another agent.");
        }

        if (claimStatus == AgentQueueService.ClaimStatus.OWNED) {
            extendAssignment(conversationId);
            agentAssignmentService.registerAssignment(agent.getId(), conversationId);
            if (conversation.getAgent() == null) {
                conversation.setAgent(agent);
            }
            if (conversation.getStatus() != ConversationStatus.ASSIGNED) {
                conversation.setStatus(ConversationStatus.ASSIGNED);
                conversation.setUpdatedAt(Instant.now());
                if (conversation.getAcceptedAt() == null) {
                    conversation.setAcceptedAt(Instant.now());
                }
                conversationRepository.saveConversation(conversation);
            }
            return conversation;
        }

        Instant now = Instant.now();
        conversation.setAgent(agent);
        conversation.setStatus(ConversationStatus.ASSIGNED);
        conversation.setAcceptedAt(now);
        conversation.setUpdatedAt(now);

        conversationRepository.saveConversation(conversation);
        agentAssignmentService.registerAssignment(agent.getId(), conversationId);

        eventPublisher.publishLifecycleEvent(ChatEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .type(ChatEventType.CONVERSATION_ACCEPTED)
                .occurredAt(conversation.getAcceptedAt())
                .payload(Map.of("agentId", agent.getId()))
                .build());

        return conversation;
    }

    public ChatMessage sendMessage(String conversationId, ChatParticipant sender, String content, ChatMessageType type) {
        ConversationMetadata conversation = conversationRepository
                .getConversation(conversationId)
                .orElseThrow(() -> new IllegalArgumentException("Conversation not found"));

        if (conversation.getStatus() == ConversationStatus.CLOSED) {
            throw new IllegalStateException("Conversation closed");
        }

        Instant now = Instant.now();

        ChatMessage message = ChatMessage.builder()
                .id(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .sender(sender)
                .type(type)
                .content(content)
                .timestamp(now)
                .build();

        conversation.setUpdatedAt(now);
        conversationRepository.saveConversation(conversation);
        conversationRepository.appendMessage(message);

        presenceService.markPresent(sender.getId());

        eventPublisher.publishMessageEvent(ChatMessageEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .message(message)
                .occurredAt(now)
                .build());

        eventPublisher.publishLifecycleEvent(ChatEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .type(ChatEventType.MESSAGE_RECEIVED)
                .occurredAt(now)
                .payload(Map.of("senderId", sender.getId()))
                .build());

        return message;
    }

    public ConversationMetadata closeConversation(String conversationId, ChatParticipant closedBy) {
        ConversationMetadata conversation = conversationRepository
                .getConversation(conversationId)
                .orElseThrow(() -> new IllegalArgumentException("Conversation not found"));

        Instant now = Instant.now();

        String closingMessage = resolveClosingMessage(conversation, closedBy);
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("event", "CHAT_CLOSED");
        if (closedBy != null && closedBy.getType() != null) {
            metadata.put("closedByType", closedBy.getType().name());
            if (StringUtils.hasText(closedBy.getDisplayName())) {
                metadata.put("closedByDisplayName", closedBy.getDisplayName());
            }
        } else if (conversation.getAgent() != null) {
            metadata.put("closedByType", ParticipantType.AGENT.name());
            if (StringUtils.hasText(conversation.getAgent().getDisplayName())) {
                metadata.put("closedByDisplayName", conversation.getAgent().getDisplayName());
            }
        }

        ChatMessage closureNotice = ChatMessage.builder()
                .id(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .sender(ChatParticipant.builder()
                        .id("system")
                        .type(ParticipantType.SYSTEM)
                        .displayName("System")
                        .metadata(Map.of())
                        .build())
                .type(ChatMessageType.SYSTEM)
                .content(closingMessage)
                .metadata(metadata)
                .timestamp(now)
                .build();

        conversationRepository.appendMessage(closureNotice);

        eventPublisher.publishMessageEvent(ChatMessageEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .message(closureNotice)
                .occurredAt(now)
                .build());

        conversation.setStatus(ConversationStatus.CLOSED);
        conversation.setClosedAt(Instant.now());
        conversation.setUpdatedAt(Instant.now());
        conversationRepository.saveConversation(conversation);
        queueService.remove(conversationId);
        if (conversation.getAgent() != null) {
            agentAssignmentService.removeAssignment(conversation.getAgent().getId(), conversationId);
        }
        releaseAssignment(conversationId);

        eventPublisher.publishLifecycleEvent(ChatEvent.builder()
                .eventId(UUID.randomUUID().toString())
                .conversationId(conversationId)
                .type(ChatEventType.CONVERSATION_CLOSED)
                .occurredAt(conversation.getClosedAt())
                .payload(Map.of(
                        "closedBy", closedBy != null ? closedBy.getId() : "system",
                        "status", conversation.getStatus().name()))
                .build());

        return conversation;
    }

    private String resolveClosingMessage(ConversationMetadata conversation, ChatParticipant closedBy) {
        if (closedBy != null) {
            if (closedBy.getType() == ParticipantType.AGENT) {
                String displayName = StringUtils.hasText(closedBy.getDisplayName())
                        ? closedBy.getDisplayName()
                        : "An agent";
                return "%s closed the chat.".formatted(displayName);
            }
            if (closedBy.getType() == ParticipantType.CUSTOMER) {
                String displayName = StringUtils.hasText(closedBy.getDisplayName())
                        ? closedBy.getDisplayName()
                        : "The customer";
                return "%s ended the chat.".formatted(displayName);
            }
        }

        String displayName = conversation.getAgent() != null ? conversation.getAgent().getDisplayName() : null;

        if (StringUtils.hasText(displayName)) {
            return "%s closed the chat.".formatted(displayName);
        }

        return "This conversation has been closed. You can start a new chat anytime you need assistance.";
    }

    private void extendAssignment(String conversationId) {
        String key = keyFactory.conversationAssignmentKey(conversationId);
        Duration ttl = chatProperties.getRedis().getConversationTtl();
        stringRedisTemplate.expire(key, ttl);
    }

    private void releaseAssignment(String conversationId) {
        stringRedisTemplate.delete(keyFactory.conversationAssignmentKey(conversationId));
    }

    private String resolveCustomerPhone(ConversationMetadata conversation) {
        if (conversation.getCustomer() == null || conversation.getCustomer().getMetadata() == null) {
            return null;
        }
        Object value = conversation.getCustomer().getMetadata().get("phone");
        if (value instanceof String phone && StringUtils.hasText(phone)) {
            return phone.trim();
        }
        return null;
    }
}

