import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';
import {
  ChatMessage,
  ConversationMetadata,
  CreateConversationPayload,
  QueueStatusResponse,
  SendMessagePayload
} from './models';

const API_BASE = environment.apiBaseUrl || '';

@Injectable({
  providedIn: 'root'
})
export class ChatApiService {
  private readonly baseUrl = API_BASE.replace(/\/$/, '');

  constructor(private readonly http: HttpClient) {}

  createConversation(payload: CreateConversationPayload, participantId?: string, displayName?: string): Observable<ConversationMetadata> {
    const headers = this.buildParticipantHeaders(participantId, displayName);
    return this.http.post<ConversationMetadata>(`${this.baseUrl}/api/conversations`, payload, { headers });
  }

  requestAgent(conversationId: string, channel = 'web'): Observable<QueueStatusResponse> {
    return this.http.post<QueueStatusResponse>(`${this.baseUrl}/api/conversations/${conversationId}/queue`, {
      channel
    });
  }

  listMessages(conversationId: string): Observable<ChatMessage[]> {
    return this.http.get<ChatMessage[]>(`${this.baseUrl}/api/conversations/${conversationId}/messages`);
  }

  sendMessage(conversationId: string, payload: SendMessagePayload): Observable<ChatMessage> {
    return this.http.post<ChatMessage>(`${this.baseUrl}/api/conversations/${conversationId}/messages`, {
      ...payload,
      senderType: payload.senderType ?? 'CUSTOMER',
      type: payload.type ?? 'TEXT'
    });
  }

  closeConversation(conversationId: string, customerId: string): Observable<ConversationMetadata> {
    const headers = new HttpHeaders({
      'X-Participant-Id': customerId
    });
    return this.http.delete<ConversationMetadata>(`${this.baseUrl}/api/conversations/${conversationId}`, {
      headers
    });
  }

  private buildParticipantHeaders(participantId?: string, displayName?: string): HttpHeaders {
    let headers = new HttpHeaders();
    if (participantId) {
      headers = headers.set('X-Participant-Id', participantId);
    }
    if (displayName) {
      headers = headers.set('X-Participant-Name', displayName);
    }
    return headers;
  }
}

