import { Injectable, NgZone } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../environments/environment';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import { ChatMessage, SocketHandshake } from './models';

const SOCKET_BASE = environment.socketUrl || '';
const MESSAGE_EVENT = 'chat:message';
const SYSTEM_EVENT = 'system:event';

export interface AgentSocketOptions {
  agentId: string;
  displayName: string;
  conversationId: string;
}

export interface AgentSocketConnection {
  conversationId: string;
  handshake$: Observable<SocketHandshake>;
  messages$: Observable<ChatMessage>;
  disconnect$: Observable<void>;
  errors$: Observable<string>;
  sendMessage(content: string, type?: string): Promise<ChatMessage>;
  disconnect(): void;
}

interface AgentSocketContext {
  socket: Socket;
  handshake$: ReplaySubject<SocketHandshake>;
  messages$: Subject<ChatMessage>;
  disconnect$: Subject<void>;
  error$: Subject<string>;
}

@Injectable({ providedIn: 'root' })
export class ChatSocketService {
  private readonly connections = new Map<string, AgentSocketContext>();

  constructor(private readonly zone: NgZone) {}

  createConnection(options: AgentSocketOptions): AgentSocketConnection {
    const conversationId = options.conversationId;

    if (this.connections.has(conversationId)) {
      return this.buildConnection(conversationId, this.connections.get(conversationId)!);
    }

    const socket = io(SOCKET_BASE.replace(/\/$/, ''), {
      transports: ['websocket'],
      query: {
        role: 'agent',
        token: options.agentId,
        displayName: options.displayName,
        conversationId
      }
    });

    const context: AgentSocketContext = {
      socket,
      handshake$: new ReplaySubject<SocketHandshake>(1),
      messages$: new Subject<ChatMessage>(),
      disconnect$: new Subject<void>(),
      error$: new Subject<string>()
    };

    this.connections.set(conversationId, context);
    this.registerListeners(conversationId, context);

    return this.buildConnection(conversationId, context);
  }

  disconnect(conversationId: string): void {
    this.destroyConnection(conversationId, true);
  }

  disconnectAll(): void {
    Array.from(this.connections.keys()).forEach((conversationId) => this.destroyConnection(conversationId, true));
  }

  private buildConnection(conversationId: string, context: AgentSocketContext): AgentSocketConnection {
    return {
      conversationId,
      handshake$: context.handshake$.asObservable(),
      messages$: context.messages$.asObservable(),
      disconnect$: context.disconnect$.asObservable(),
      errors$: context.error$.asObservable(),
      sendMessage: (content: string, type: string = 'TEXT') =>
        new Promise<ChatMessage>((resolve, reject) => {
          const socketContext = this.connections.get(conversationId);
          if (!socketContext) {
            reject(new Error('Socket not connected'));
            return;
          }

          socketContext.socket.emit(MESSAGE_EVENT, { conversationId, content, type }, (response: ChatMessage | { error?: string }) =>
            this.zone.run(() => {
              if (response && typeof response === 'object' && 'error' in response) {
                reject(new Error(response.error ?? 'Unable to send message'));
              } else {
                resolve(response as ChatMessage);
              }
            })
          );
        }),
      disconnect: () => this.disconnect(conversationId)
    };
  }

  private registerListeners(conversationId: string, context: AgentSocketContext): void {
    const { socket, handshake$, messages$, error$, disconnect$ } = context;

    socket.on('connect_error', (error: Error) => {
      this.zone.run(() => {
        handshake$.error(error);
        error$.next(error.message ?? 'Unable to connect to chat service.');
      });
    });

    socket.on(SYSTEM_EVENT, (payload: SocketHandshake) => {
      this.zone.run(() => handshake$.next(payload));
    });

    socket.on(MESSAGE_EVENT, (payload: ChatMessage) => {
      this.zone.run(() => messages$.next(payload));
    });

    socket.on('system:error', (payload: { message?: string }) => {
      this.zone.run(() => error$.next(payload?.message ?? 'Chat service error'));
    });

    socket.on('disconnect', () => {
      this.zone.run(() => {
        disconnect$.next();
        this.destroyConnection(conversationId, false);
      });
    });
  }

  private destroyConnection(conversationId: string, closeSocket: boolean): void {
    const context = this.connections.get(conversationId);
    if (!context) {
      return;
    }

    context.socket.removeAllListeners();
    if (closeSocket) {
      context.socket.disconnect();
    }
    context.handshake$.complete();
    context.messages$.complete();
    context.disconnect$.complete();
    context.error$.complete();
    this.connections.delete(conversationId);
  }
}

