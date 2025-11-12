package com.example.chat.service;

import com.example.chat.config.ChatProperties;
import com.example.chat.domain.ChatMessage;
import com.example.chat.domain.ConversationMetadata;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class RedisConversationRepository implements ConversationRepository {

    private final RedisTemplate<String, Object> redisTemplate;
    private final ObjectMapper objectMapper;
    private final RedisKeyFactory keyFactory;
    private final ChatProperties chatProperties;

    public RedisConversationRepository(
            RedisTemplate<String, Object> redisTemplate,
            RedisKeyFactory keyFactory,
            ChatProperties chatProperties,
            ObjectMapper objectMapper) {
        this.redisTemplate = redisTemplate;
        this.keyFactory = keyFactory;
        this.chatProperties = chatProperties;
        this.objectMapper = objectMapper;
    }

    @Override
    public void saveConversation(ConversationMetadata conversation) {
        String key = keyFactory.conversationKey(conversation.getId());
        redisTemplate.opsForValue()
                .set(key, writeAsJson(conversation), ttl().toMillis(), TimeUnit.MILLISECONDS);
    }

    @Override
    public Optional<ConversationMetadata> getConversation(String conversationId) {
        String key = keyFactory.conversationKey(conversationId);
        Object value = redisTemplate.opsForValue().get(key);
        return readConversation(value);
    }

    @Override
    public void deleteConversation(String conversationId) {
        redisTemplate.delete(keyFactory.conversationKey(conversationId));
        redisTemplate.delete(keyFactory.messagesKey(conversationId));
    }

    @Override
    public void appendMessage(ChatMessage message) {
        String key = keyFactory.messagesKey(message.getConversationId());
        redisTemplate.opsForList().rightPush(key, writeAsJson(message));
        redisTemplate.expire(keyFactory.conversationKey(message.getConversationId()), ttl());
        redisTemplate.expire(key, ttl());
    }

    @Override
    public List<ChatMessage> getMessages(String conversationId, int limit) {
        String key = keyFactory.messagesKey(conversationId);
        List<Object> range = redisTemplate.opsForList().range(key, -limit, -1);
        if (range == null) {
            return List.of();
        }
        return range.stream()
                .flatMap(this::readMessage)
                .toList();
    }

    @Override
    public List<ConversationMetadata> findAll() {
        Set<String> keys = redisTemplate.keys(keyFactory.conversationPattern());
        if (keys == null || keys.isEmpty()) {
            return List.of();
        }
        return keys.stream()
                .filter(key -> !key.endsWith(":messages"))
                .filter(key -> !key.endsWith(":agent"))
                .map(redisTemplate.opsForValue()::get)
                .map(this::readConversation)
                .flatMap(Optional::stream)
                .collect(Collectors.toList());
    }

    private Duration ttl() {
        return chatProperties.getRedis().getConversationTtl();
    }

    private String writeAsJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize value for Redis", e);
        }
    }

    private Optional<ConversationMetadata> readConversation(Object value) {
        if (value == null) {
            return Optional.empty();
        }
        if (value instanceof ConversationMetadata metadata) {
            return Optional.of(metadata);
        }
        if (value instanceof String raw) {
            try {
                return Optional.of(objectMapper.readValue(raw, ConversationMetadata.class));
            } catch (JsonProcessingException ignored) {
                return Optional.empty();
            }
        }
        return Optional.empty();
    }

    private Stream<ChatMessage> readMessage(Object value) {
        if (value instanceof ChatMessage message) {
            return Stream.of(message);
        }
        if (value instanceof String raw) {
            try {
                return Stream.of(objectMapper.readValue(raw, ChatMessage.class));
            } catch (JsonProcessingException ignored) {
                return Stream.empty();
            }
        }
        return Stream.empty();
    }
}

