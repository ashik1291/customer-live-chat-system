package com.example.chat.domain;

import java.io.Serializable;
import java.time.Instant;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class QueueEntry implements Serializable {

    private String conversationId;
    private Instant enqueuedAt;
    private String customerId;
    private String channel;
    private String customerName;
    private String customerPhone;
}

