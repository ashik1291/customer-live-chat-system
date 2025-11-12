package com.example.chat.config;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "chat.security")
public class ChatSecurityProperties {

    /**
     * Toggle to enable or disable the inbound HTTP rate limiter.
     */
    private boolean rateLimitingEnabled = true;

    private final RateLimit rateLimit = new RateLimit();

    /**
     * Explicit list of origins allowed to call the HTTP API. Ignored when
     * {@link #allowedOriginPatterns} is configured.
     */
    private List<String> allowedOrigins =
            new ArrayList<>(List.of("http://localhost:4200", "http://localhost:4201"));

    /**
     * Optional set of origin patterns (see
     * {@link org.springframework.web.cors.CorsConfiguration#setAllowedOriginPatterns})
     * that can be used to allow wildcard matches such as {@code http://*:4200}.
     */
    private List<String> allowedOriginPatterns = new ArrayList<>();

    public boolean isRateLimitingEnabled() {
        return rateLimitingEnabled;
    }

    public void setRateLimitingEnabled(boolean rateLimitingEnabled) {
        this.rateLimitingEnabled = rateLimitingEnabled;
    }

    public RateLimit getRateLimit() {
        return rateLimit;
    }

    public List<String> getAllowedOrigins() {
        return allowedOrigins;
    }

    public void setAllowedOrigins(List<String> allowedOrigins) {
        this.allowedOrigins = allowedOrigins != null ? new ArrayList<>(allowedOrigins) : new ArrayList<>();
    }

    public List<String> getAllowedOriginPatterns() {
        return allowedOriginPatterns;
    }

    public void setAllowedOriginPatterns(List<String> allowedOriginPatterns) {
        this.allowedOriginPatterns =
                allowedOriginPatterns != null ? new ArrayList<>(allowedOriginPatterns) : new ArrayList<>();
    }

    @Validated
    public static class RateLimit {

        /**
         * Maximum number of requests allowed per refill period.
         */
        private long capacity = 200;

        /**
         * Number of tokens replenished every {@link #refillPeriod}.
         */
        private long refillTokens = 200;

        /**
         * Interval at which tokens are replenished.
         */
        private Duration refillPeriod = Duration.ofSeconds(60);

        public long getCapacity() {
            return capacity;
        }

        public void setCapacity(long capacity) {
            this.capacity = capacity;
        }

        public long getRefillTokens() {
            return refillTokens;
        }

        public void setRefillTokens(long refillTokens) {
            this.refillTokens = refillTokens;
        }

        public Duration getRefillPeriod() {
            return refillPeriod;
        }

        public void setRefillPeriod(Duration refillPeriod) {
            this.refillPeriod = refillPeriod;
        }
    }
}

