package com.example.chat.service;

import com.example.chat.domain.QueueEntry;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

@Service
public class AgentQueueService {

    private static final DefaultRedisScript<List> CLAIM_FOR_AGENT_SCRIPT;

    static {
        CLAIM_FOR_AGENT_SCRIPT = new DefaultRedisScript<>();
        CLAIM_FOR_AGENT_SCRIPT.setResultType(List.class);
        CLAIM_FOR_AGENT_SCRIPT.setScriptText(
                """
                local queueKey = KEYS[1]
                local assignmentKey = KEYS[2]
                local conversationId = ARGV[1]
                local agentId = ARGV[2]
                local ttl = tonumber(ARGV[3])

                local owner = redis.call('GET', assignmentKey)
                if owner and owner ~= agentId then
                    return {'BUSY'}
                end

                local entries = redis.call('ZRANGE', queueKey, 0, -1)
                for _, raw in ipairs(entries) do
                    local ok, decoded = pcall(cjson.decode, raw)
                    if ok and decoded ~= nil and decoded['conversationId'] == conversationId then
                        redis.call('ZREM', queueKey, raw)
                        redis.call('SET', assignmentKey, agentId)
                        if ttl and ttl > 0 then
                            redis.call('PEXPIRE', assignmentKey, ttl)
                        end
                        return {'CLAIMED', raw}
                    end
                end

                if owner == agentId then
                    if ttl and ttl > 0 then
                        redis.call('PEXPIRE', assignmentKey, ttl)
                    end
                    return {'OWNED'}
                end

                return {'MISSING'}
                """);
    }

    private final StringRedisTemplate redisTemplate;
    private final RedisKeyFactory keyFactory;
    private final ObjectMapper objectMapper;

    public AgentQueueService(
            StringRedisTemplate redisTemplate, RedisKeyFactory keyFactory, ObjectMapper objectMapper) {
        this.redisTemplate = redisTemplate;
        this.keyFactory = keyFactory;
        this.objectMapper = objectMapper;
    }

    public void enqueue(QueueEntry entry) {
        try {
            String key = keyFactory.queueKey();
            redisTemplate.opsForZSet()
                    .add(key, objectMapper.writeValueAsString(entry), entry.getEnqueuedAt().toEpochMilli());
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unable to serialize queue entry", e);
        }
    }

    public ClaimResult claimForAgent(String conversationId, String agentId, Duration assignmentTtl) {
        long ttlMillis = assignmentTtl != null && !assignmentTtl.isNegative() ? assignmentTtl.toMillis() : 0L;
        @SuppressWarnings("unchecked")
        List<String> response = (List<String>) redisTemplate.execute(
                CLAIM_FOR_AGENT_SCRIPT,
                List.of(keyFactory.queueKey(), keyFactory.conversationAssignmentKey(conversationId)),
                conversationId,
                agentId,
                String.valueOf(ttlMillis));

        if (response == null || response.isEmpty()) {
            return new ClaimResult(ClaimStatus.MISSING, Optional.empty());
        }

        String status = response.get(0);
        Optional<QueueEntry> entry =
                response.size() > 1 ? deserialize(response.get(1)) : Optional.empty();

        return new ClaimResult(ClaimStatus.valueOf(status), entry);
    }

    public Optional<QueueEntry> peek() {
        Set<String> values =
                redisTemplate.opsForZSet().range(keyFactory.queueKey(), 0, 0);
        if (values == null || values.isEmpty()) {
            return Optional.empty();
        }
        return values.stream().findFirst().flatMap(this::deserialize);
    }

    public Optional<QueueEntry> remove(String conversationId) {
        Set<String> all =
                redisTemplate.opsForZSet().range(keyFactory.queueKey(), 0, -1);
        if (all == null) {
            return Optional.empty();
        }
        for (String raw : all) {
            Optional<QueueEntry> entry = deserialize(raw);
            if (entry.isPresent() && conversationId.equals(entry.get().getConversationId())) {
                redisTemplate.opsForZSet().remove(keyFactory.queueKey(), raw);
                return entry;
            }
        }
        return Optional.empty();
    }

    public List<QueueEntry> listQueue(int limit) {
        Set<String> values =
                redisTemplate.opsForZSet().range(keyFactory.queueKey(), 0, Math.max(limit - 1, 0));
        if (values == null) {
            return List.of();
        }
        return values.stream()
                .map(this::deserialize)
                .flatMap(Optional::stream)
                .toList();
    }

    public long position(String conversationId) {
        Set<String> values = redisTemplate.opsForZSet().range(keyFactory.queueKey(), 0, -1);
        if (values == null) {
            return -1;
        }
        int index = 0;
        for (String raw : values) {
            Optional<QueueEntry> entry = deserialize(raw);
            if (entry.isPresent() && conversationId.equals(entry.get().getConversationId())) {
                return index;
            }
            index++;
        }
        return -1;
    }

    public void touch(String conversationId) {
        Set<String> values = redisTemplate.opsForZSet().range(keyFactory.queueKey(), 0, -1);
        if (values == null) {
            return;
        }
        for (String raw : values) {
            Optional<QueueEntry> entryOpt = deserialize(raw);
            if (entryOpt.isPresent() && conversationId.equals(entryOpt.get().getConversationId())) {
                QueueEntry updated = QueueEntry.builder()
                        .conversationId(entryOpt.get().getConversationId())
                        .customerId(entryOpt.get().getCustomerId())
                        .channel(entryOpt.get().getChannel())
                        .enqueuedAt(Instant.now())
                        .build();
                redisTemplate.opsForZSet().remove(keyFactory.queueKey(), raw);
                enqueue(updated);
                break;
            }
        }
    }

    public List<QueueEntry> purgeOlderThan(Duration ttl) {
        if (ttl == null || ttl.isZero() || ttl.isNegative()) {
            return List.of();
        }
        Instant cutoff = Instant.now().minus(ttl);
        Set<String> stale = redisTemplate
                .opsForZSet()
                .rangeByScore(keyFactory.queueKey(), 0, cutoff.toEpochMilli());
        if (stale == null || stale.isEmpty()) {
            return List.of();
        }
        List<QueueEntry> removed = new ArrayList<>();
        for (String raw : stale) {
            Optional<QueueEntry> entry = deserialize(raw);
            if (entry.isPresent()) {
                redisTemplate.opsForZSet().remove(keyFactory.queueKey(), raw);
                removed.add(entry.get());
            }
        }
        return removed;
    }

    private Optional<QueueEntry> deserialize(String raw) {
        try {
            return Optional.of(objectMapper.readValue(raw, QueueEntry.class));
        } catch (JsonProcessingException e) {
            return Optional.empty();
        }
    }

    public enum ClaimStatus {
        CLAIMED,
        OWNED,
        MISSING,
        BUSY
    }

    public record ClaimResult(ClaimStatus status, Optional<QueueEntry> entry) {}
}

