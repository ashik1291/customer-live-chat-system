package com.example.chat.service;

import com.example.chat.config.ChatProperties;
import org.springframework.stereotype.Component;

@Component
public class RedisKeyFactory {

    private final ChatProperties chatProperties;

    public RedisKeyFactory(ChatProperties chatProperties) {
        this.chatProperties = chatProperties;
    }

    private String prefix() {
        return chatProperties.getRedis().getKeyPrefix();
    }

    public String conversationKey(String conversationId) {
        return "%s:conversation:%s".formatted(prefix(), conversationId);
    }

    public String messagesKey(String conversationId) {
        return "%s:conversation:%s:messages".formatted(prefix(), conversationId);
    }

    public String conversationAssignmentKey(String conversationId) {
        return "%s:conversation:%s:agent".formatted(prefix(), conversationId);
    }

    public String conversationPattern() {
        return "%s:conversation:*".formatted(prefix());
    }

    public String queueKey() {
        return "%s:queue:pending".formatted(prefix());
    }

    public String agentLoadKey(String agentId) {
        return "%s:agent:%s:load".formatted(prefix(), agentId);
    }

    public String agentConversationSetKey(String agentId) {
        return "%s:agent:%s:conversations".formatted(prefix(), agentId);
    }

    public String presenceKey(String participantId) {
        return "%s:presence:%s".formatted(prefix(), participantId);
    }
}

