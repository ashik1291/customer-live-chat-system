package com.example.chat.service;

import com.example.chat.domain.ChatParticipant;
import com.example.chat.domain.ParticipantType;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
public class ParticipantIdentityService {

    public ChatParticipant resolveCustomer(
            String participantId, String fingerprint, String displayName, Map<String, Object> metadata) {
        String resolvedId = StringUtils.hasText(participantId)
                ? participantId
                : (StringUtils.hasText(fingerprint) ? "anon-" + fingerprint : UUID.randomUUID().toString());

        String resolvedName = StringUtils.hasText(displayName) ? displayName : "Guest";

        return resolveParticipant(resolvedId, ParticipantType.CUSTOMER, resolvedName, metadata);
    }

    public ChatParticipant resolveAgent(String agentId, String displayName, Map<String, Object> metadata) {
        if (!StringUtils.hasText(agentId)) {
            throw new IllegalArgumentException("Agent identifier is required");
        }

        String resolvedName = StringUtils.hasText(displayName) ? displayName : "Agent";

        return resolveParticipant(agentId, ParticipantType.AGENT, resolvedName, metadata);
    }

    public ChatParticipant resolveParticipant(
            String id, ParticipantType type, String displayName, Map<String, Object> metadata) {
        if (!StringUtils.hasText(id)) {
            throw new IllegalArgumentException("Participant identifier is required");
        }

        Map<String, Object> safeMetadata = new HashMap<>();
        if (metadata != null && !metadata.isEmpty()) {
            safeMetadata.putAll(metadata);
        }
        safeMetadata.putIfAbsent("role", type.name().toLowerCase());

        String resolvedName;
        if (StringUtils.hasText(displayName)) {
            resolvedName = displayName;
        } else if (type == ParticipantType.CUSTOMER) {
            resolvedName = "Guest";
        } else {
            String typeName = type.name().toLowerCase();
            resolvedName = Character.toUpperCase(typeName.charAt(0)) + typeName.substring(1);
        }

        return ChatParticipant.builder()
                .id(id)
                .type(type)
                .displayName(resolvedName)
                .metadata(safeMetadata)
                .build();
    }
}

