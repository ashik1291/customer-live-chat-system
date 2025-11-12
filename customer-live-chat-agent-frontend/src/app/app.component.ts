import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChildren,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Subscription, catchError, interval, of, startWith, switchMap, take } from 'rxjs';
import { ChatApiService } from './chat-api.service';
import { AgentSocketConnection, ChatSocketService } from './chat-socket.service';
import { ChatMessage, ConversationMetadata, QueueEntry } from './models';

enum AgentStage {
  Idle = 'IDLE',
  Connecting = 'CONNECTING',
  Active = 'ACTIVE',
  Ended = 'ENDED'
}

interface AgentSession {
  agentId: string;
  displayName: string;
}

interface AgentChatSession {
  id: string;
  conversation: ConversationMetadata | null;
  stage: AgentStage;
  statusText: string;
  messages: ChatMessage[];
  messageForm: FormGroup;
  isSending: boolean;
  isConnecting: boolean;
  connection: AgentSocketConnection;
  subscriptions: Subscription[];
  errorText: string | null;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  readonly AgentStage = AgentStage;
  readonly maxConcurrentChats = 3;

  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ChatApiService);
  private readonly sockets = inject(ChatSocketService);

  readonly agentSession = signal<AgentSession | null>(null);
  readonly queue = signal<QueueEntry[]>([]);
  readonly activeChats = signal<AgentChatSession[]>([]);
  readonly queueActionErrors = signal<Record<string, string>>({});
  readonly queueError = signal<string | null>(null);
  readonly chatError = signal<string | null>(null);
  readonly isConnecting = signal(false);

  readonly statusText = computed(() =>
    this.activeChats().length
      ? `Managing ${this.activeChats().length} simultaneous chat${this.activeChats().length > 1 ? 's' : ''}.`
      : 'Pick a chat request to connect with a customer.'
  );

  readonly loginForm = this.fb.group({
    agentId: ['', [Validators.required, Validators.minLength(3)]],
    displayName: ['', [Validators.required, Validators.minLength(2)]]
  });

  @ViewChildren('chatHistory') private chatHistories?: QueryList<ElementRef<HTMLDivElement>>;

  private readonly chatHistoryMap = new Map<string, HTMLDivElement>();
  private queueSubscription?: Subscription;

  ngOnInit(): void {
    const stored = this.readStoredSession();
    if (stored) {
      this.agentSession.set(stored);
      this.loginForm.patchValue(stored);
      this.startQueuePolling();
      this.restoreActiveChats(stored);
    }
  }

  ngAfterViewInit(): void {
    this.refreshChatHistoryMap();
    this.chatHistories?.changes.subscribe(() => this.refreshChatHistoryMap());
  }

  ngOnDestroy(): void {
    this.stopQueuePolling();
    this.teardownAllChats();
    this.sockets.disconnectAll();
  }

  signIn(): void {
    if (this.loginForm.invalid) {
      this.loginForm.markAllAsTouched();
      return;
    }

    const agentId = this.loginForm.controls.agentId.value?.trim() ?? '';
    const displayName = this.loginForm.controls.displayName.value?.trim() ?? '';
    if (!agentId || !displayName) {
      return;
    }

    const session: AgentSession = { agentId, displayName };
    this.agentSession.set(session);
    this.persistSession(session);
    this.startQueuePolling();
    this.restoreActiveChats(session);
  }

  signOut(): void {
    this.stopQueuePolling();
    this.teardownAllChats();
    this.sockets.disconnectAll();
    this.agentSession.set(null);
    this.queue.set([]);
    this.queueActionErrors.set({});
    localStorage.removeItem('agentSession');
  }

  joinConversation(entry: QueueEntry): void {
    const agent = this.agentSession();
    if (!agent || this.isConnecting()) {
      return;
    }

    if (this.activeChats().length >= this.maxConcurrentChats) {
      this.chatError.set(`You already have ${this.maxConcurrentChats} active chats.`);
      return;
    }

    if (this.activeChats().some((chat) => chat.id === entry.conversationId)) {
      this.chatError.set('You are already connected to this conversation.');
      return;
    }

    this.isConnecting.set(true);
    this.chatError.set(null);
    this.chatError.set(null);
    this.setQueueActionError(entry.conversationId, null);
    this.api
      .acceptConversation(entry.conversationId, {
        agentId: agent.agentId,
        displayName: agent.displayName
      })
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          const message = this.resolveErrorMessage(error, 'Unable to join this chat request.');
          this.chatError.set(message);
          this.setQueueActionError(entry.conversationId, message);
          this.isConnecting.set(false);
          this.refreshQueue();
          return of<ConversationMetadata | null>(null);
        })
      )
      .subscribe((conversation) => {
        this.isConnecting.set(false);
        if (conversation) {
          this.openConversationSession(conversation, agent);
          this.setQueueActionError(entry.conversationId, null);
          this.refreshQueue();
        }
      });
  }

  refreshQueue(): void {
    this.api
      .listQueue()
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          this.queueError.set(this.resolveErrorMessage(error, 'Unable to load the queue.'));
          return of<QueueEntry[]>([]);
        })
      )
      .subscribe((entries) => {
        this.queueError.set(null);
        this.queue.set(entries);
        this.pruneQueueActionErrors(entries);
      });
  }

  sendMessage(conversationId: string): void {
    const chat = this.findChat(conversationId);
    if (!chat) {
      return;
    }

    if (chat.messageForm.invalid) {
      chat.messageForm.markAllAsTouched();
      return;
    }

    const content = chat.messageForm.controls['content'].value?.trim();
    if (!content) {
      return;
    }

    const connection = chat.connection;
    const messageForm = chat.messageForm;

    this.updateChatSession(conversationId, (session) => {
      session.isSending = true;
      session.errorText = null;
    });
    this.chatError.set(null);

    connection
      .sendMessage(content)
      .then(() => {
        messageForm.reset();
      })
      .catch((error) => this.setChatError(conversationId, error.message ?? 'Unable to send message.'))
      .finally(() => {
        this.updateChatSession(conversationId, (session) => {
          session.isSending = false;
        });
      });
  }

  onComposerKeydown(event: KeyboardEvent, conversationId: string): void {
    if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    event.preventDefault();
    this.sendMessage(conversationId);
  }

  closeConversation(conversationId: string): void {
    const agent = this.agentSession();
    const chat = this.findChat(conversationId);
    if (!agent || !chat || chat.stage === AgentStage.Ended || !chat.conversation) {
      return;
    }

    this.updateChatSession(conversationId, (session) => {
      session.isSending = true;
      session.errorText = null;
      session.stage = AgentStage.Ended;
      session.messageForm.disable({ emitEvent: false });
    });

    this.api
      .closeConversation(conversationId, {
        agentId: agent.agentId,
        displayName: agent.displayName
      })
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          this.setChatError(conversationId, this.resolveErrorMessage(error, 'Unable to close the conversation.'));
          return of<ConversationMetadata | null>(null);
        })
      )
      .subscribe(() => {
        this.updateChatSession(conversationId, (session) => {
          session.isSending = false;
          session.statusText = 'Conversation closed. Waiting for confirmation.';
        });
        this.refreshQueue();
      });
  }

  dismissChat(conversationId: string): void {
    const chats = [...this.activeChats()];
    const index = chats.findIndex((chat) => chat.id === conversationId);
    if (index === -1) {
      return;
    }
    const [removed] = chats.splice(index, 1);
    removed.subscriptions.forEach((sub) => sub.unsubscribe());
    removed.connection.disconnect();
    this.activeChats.set(chats);
  }

  trackQueue(_index: number, entry: QueueEntry): string {
    return entry.conversationId;
  }

  trackMessage(_index: number, message: ChatMessage): string {
    return message.id;
  }

  trackChat(_index: number, chat: AgentChatSession): string {
    return chat.id;
  }

  messageClasses(message: ChatMessage): Record<string, boolean> {
    const senderType = message.sender?.type?.toUpperCase();
    return {
      'message-bubble': true,
      'message-agent': senderType === 'AGENT',
      'message-customer': senderType === 'CUSTOMER',
      'message-system': senderType === 'SYSTEM'
    };
  }

  private openConversationSession(conversation: ConversationMetadata, agent: AgentSession): void {
    const connection = this.sockets.createConnection({
      agentId: agent.agentId,
      displayName: agent.displayName,
      conversationId: conversation.id
    });

    const messageForm = this.fb.group({
      content: ['', [Validators.required, Validators.minLength(1)]]
    });
    messageForm.disable({ emitEvent: false });

    const chatSession: AgentChatSession = {
      id: conversation.id,
      conversation,
      stage: AgentStage.Connecting,
      statusText: 'Connecting to the customer...',
      messages: [],
      messageForm,
      isSending: false,
      isConnecting: true,
      connection,
      subscriptions: [],
      errorText: null
    };

    this.activeChats.update((chats) => [...chats, chatSession]);

    const handshakeSub = connection.handshake$.pipe(take(1)).subscribe({
      next: (handshake) => {
        this.updateChatSession(conversation.id, (session) => {
          session.conversation = handshake.conversation;
          session.stage = AgentStage.Active;
          session.statusText = `You are now connected with ${
            handshake.conversation.customer?.displayName ||
            handshake.conversation.customer?.id ||
            'the customer'
          }.`;
          session.isConnecting = false;
          session.messageForm.enable({ emitEvent: false });
        });
        this.chatError.set(null);
        this.loadHistory(conversation.id, agent.agentId);
        this.scrollChatToBottom(conversation.id, 'smooth');
      },
      error: (error) => this.setChatError(conversation.id, error.message ?? 'Unable to connect to chat service.')
    });
    chatSession.subscriptions.push(handshakeSub);

    const messageSub = connection.messages$.subscribe((message) => this.handleIncomingMessage(conversation.id, message));
    chatSession.subscriptions.push(messageSub);

    const errorSub = connection.errors$.subscribe((error) => this.setChatError(conversation.id, error));
    chatSession.subscriptions.push(errorSub);

    const disconnectSub = connection.disconnect$.subscribe(() => this.onChatDisconnected(conversation.id));
    chatSession.subscriptions.push(disconnectSub);
  }

  private loadHistory(conversationId: string, agentId: string): void {
    this.api
      .listConversationMessages(conversationId, agentId)
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          this.setChatError(conversationId, this.resolveErrorMessage(error, 'Unable to load previous messages.'));
          return of<ChatMessage[]>([]);
        })
      )
      .subscribe((history) => {
        if (!history.length) {
          return;
        }
        this.updateChatSession(conversationId, (session) => {
          session.messages = this.mergeMessages(session.messages, history);
          session.stage = AgentStage.Active;
          session.isConnecting = false;
        });
        this.scrollChatToBottom(conversationId);
      });
  }

  private handleIncomingMessage(conversationId: string, message: ChatMessage): void {
    this.updateChatSession(conversationId, (session) => {
      session.messages = this.mergeMessages(session.messages, [message]);

      const senderType = message.sender?.type?.toUpperCase();
      if (senderType === 'CUSTOMER') {
        session.statusText = `${message.sender?.displayName || 'Customer'} is waiting for your reply.`;
      }

      if (message.type?.toUpperCase() === 'SYSTEM') {
        session.messageForm.disable({ emitEvent: false });
        session.connection.disconnect();
        session.stage = AgentStage.Ended;
        session.statusText = message.content || 'The chat was closed.';
        session.isSending = false;
      }
    });
    this.scrollChatToBottom(conversationId, 'smooth');
  }

  private onChatDisconnected(conversationId: string): void {
    this.updateChatSession(conversationId, (session) => {
      if (session.stage === AgentStage.Ended) {
        return;
      }
      session.messageForm.disable({ emitEvent: false });
      session.errorText = 'Connection lost. Reopen the conversation if you need to continue.';
      session.stage = AgentStage.Ended;
      session.isSending = false;
    });
  }

  private mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    const byId = new Map<string, ChatMessage>();
    [...existing, ...incoming].forEach((msg) => byId.set(msg.id, msg));
    return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private findChat(conversationId: string): AgentChatSession | undefined {
    return this.activeChats().find((chat) => chat.id === conversationId);
  }

  private setChatError(conversationId: string, error: string): void {
    this.chatError.set(error);
    this.updateChatSession(conversationId, (session) => {
      session.errorText = error;
      session.isSending = false;
    });
  }

  private teardownAllChats(): void {
    const chats = this.activeChats();
    chats.forEach((chat) => {
      chat.subscriptions.forEach((sub) => sub.unsubscribe());
      chat.connection.disconnect();
    });
    this.activeChats.set([]);
  }

  private updateChatSession(conversationId: string, updater: (chat: AgentChatSession) => void): void {
    this.activeChats.update((chats) => {
      let changed = false;
      const next = chats.map((chat) => {
        if (chat.id !== conversationId) {
          return chat;
        }
        updater(chat);
        changed = true;
        return chat;
      });
      return changed ? [...next] : chats;
    });
  }

  private setQueueActionError(conversationId: string, message: string | null): void {
    this.queueActionErrors.update((current) => {
      const next = { ...current };
      if (!message) {
        delete next[conversationId];
      } else {
        next[conversationId] = message;
      }
      return next;
    });
  }

  private pruneQueueActionErrors(entries: QueueEntry[]): void {
    const ids = new Set(entries.map((entry) => entry.conversationId));
    this.queueActionErrors.update((current) => {
      const next = { ...current };
      Object.keys(next).forEach((conversationId) => {
        if (!ids.has(conversationId)) {
          delete next[conversationId];
        }
      });
      return next;
    });
  }

  private startQueuePolling(): void {
    this.stopQueuePolling();
    this.refreshQueue();

    this.queueSubscription = interval(5000)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.api.listQueue().pipe(
            catchError((error) => {
              console.error(error);
              this.queueError.set(this.resolveErrorMessage(error, 'Unable to refresh the queue.'));
              return of<QueueEntry[]>([]);
            })
          )
        )
      )
      .subscribe((entries) => {
        this.queueError.set(null);
        this.queue.set(entries);
        this.pruneQueueActionErrors(entries);
      });
  }

  private stopQueuePolling(): void {
    this.queueSubscription?.unsubscribe();
    this.queueSubscription = undefined;
  }

  private restoreActiveChats(agent: AgentSession): void {
    this.api
      .listAgentConversations(agent.agentId, ['ASSIGNED'])
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          this.chatError.set(this.resolveErrorMessage(error, 'Unable to load assigned conversations.'));
          return of<ConversationMetadata[]>([]);
        })
      )
      .subscribe((conversations) => {
        const availableSlots = this.maxConcurrentChats - this.activeChats().length;
        if (availableSlots <= 0) {
          return;
        }

        conversations
          .filter((conversation) => !this.activeChats().some((chat) => chat.id === conversation.id))
          .slice(0, availableSlots)
          .forEach((conversation) => this.openConversationSession(conversation, agent));

        if (conversations.length) {
          this.chatError.set(null);
        }
      });
  }

  private readStoredSession(): AgentSession | null {
    try {
      const raw = localStorage.getItem('agentSession');
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as AgentSession;
      if (parsed.agentId && parsed.displayName) {
        return parsed;
      }
    } catch (error) {
      console.warn('Failed to restore agent session', error);
    }
    return null;
  }

  private persistSession(session: AgentSession): void {
    localStorage.setItem('agentSession', JSON.stringify(session));
  }

  private resolveErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const message = this.resolveHttpError(error);
      if (message) {
        return message;
      }
    }

    if (error && typeof error === 'object') {
      if ('error' in error) {
        const payload = (error as any).error;
        if (typeof payload === 'string') {
          return payload;
        }
        if (payload?.message) {
          return payload.message;
        }
      }
      if ('message' in error && typeof (error as any).message === 'string') {
        return (error as any).message;
      }
    }
    return fallback;
  }

  private resolveHttpError(error: HttpErrorResponse): string | null {
    if (error.status === 0) {
      return 'Unable to reach the chat service. Check your connection and try again.';
    }

    switch (error.status) {
      case 401:
      case 403:
        return 'You are not allowed to perform this action. Please sign in again.';
      case 404:
        return 'This conversation is no longer available.';
      case 409:
        return 'Another agent accepted this conversation moments ago.';
      case 422:
        return 'The request could not be processed. Please verify the details and try again.';
    }

    const payload = error.error;
    if (typeof payload === 'string' && payload.trim()) {
      return payload;
    }
    if (payload && typeof payload === 'object') {
      if ('message' in payload && typeof payload.message === 'string') {
        return payload.message;
      }
      if ('error' in payload && typeof payload.error === 'string') {
        return payload.error;
      }
    }

    return error.message || null;
  }

  private refreshChatHistoryMap(): void {
    this.chatHistoryMap.clear();
    this.chatHistories?.forEach((ref) => {
      const element = ref.nativeElement;
      const conversationId = element.dataset['conversationId'];
      if (conversationId) {
        this.chatHistoryMap.set(conversationId, element);
      }
    });
  }

  private runAfterDomUpdate(task: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(task));
  }

  private scrollChatToBottom(conversationId: string, behavior: ScrollBehavior = 'auto'): void {
    this.runAfterDomUpdate(() => {
      this.refreshChatHistoryMap();
      const element = this.chatHistoryMap.get(conversationId);
      if (!element) {
        return;
      }
      element.scrollTo({ top: element.scrollHeight, behavior });
    });
  }
}


