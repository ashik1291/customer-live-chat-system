package com.example.chat.config;

import java.util.List;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.CorsRegistration;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebCorsConfig implements WebMvcConfigurer {

    private final ChatSecurityProperties securityProperties;

    public WebCorsConfig(ChatSecurityProperties securityProperties) {
        this.securityProperties = securityProperties;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        CorsRegistration registration = registry.addMapping("/api/**")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .exposedHeaders("Location")
                .allowCredentials(true)
                .maxAge(3600);

        List<String> originPatterns = securityProperties.getAllowedOriginPatterns();
        List<String> origins = securityProperties.getAllowedOrigins();

        if (originPatterns != null && !originPatterns.isEmpty()) {
            registration.allowedOriginPatterns(originPatterns.toArray(new String[0]));
        } else if (origins != null && !origins.isEmpty()) {
            registration.allowedOrigins(origins.toArray(new String[0]));
        } else {
            registration.allowedOriginPatterns("*");
        }
    }
}

