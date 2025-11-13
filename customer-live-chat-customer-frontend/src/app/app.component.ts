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
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Subscription, catchError, finalize, of, switchMap, take } from 'rxjs';
import { ChatApiService } from './chat-api.service';
import { ChatSocketService } from './chat-socket.service';
import {
  ChatMessage,
  ConversationMetadata,
  CreateConversationPayload,
  QueueStatusResponse,
  SocketHandshake
} from './models';

enum ChatStage {
  Idle = 'IDLE',
  Confirm = 'CONFIRM',
  Connecting = 'CONNECTING',
  Waiting = 'WAITING',
  Active = 'ACTIVE',
  Ended = 'ENDED'
}

interface StoredCustomerSession {
  token: string;
  displayName: string;
  phone?: string;
}

interface StoredConversationState {
  conversation: ConversationMetadata;
  customerId: string;
  queueStatus?: QueueStatusResponse | null;
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
  readonly ChatStage = ChatStage;

  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ChatApiService);
  private readonly socket = inject(ChatSocketService);

  readonly isWidgetOpen = signal(false);
  readonly stage = signal(ChatStage.Idle);
  private readonly greetingText = 'Hi there! How can we help you today?';

  readonly statusText = signal(this.greetingText);
  readonly errorText = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly queueStatus = signal<QueueStatusResponse | null>(null);
  readonly conversation = signal<ConversationMetadata | null>(null);
  readonly participantId = signal<string | null>(null);
  readonly isSending = signal(false);

  @ViewChildren('historyContainer') private historyContainers?: QueryList<ElementRef<HTMLDivElement>>;

  readonly canSendMessages = computed(() => this.stage() === ChatStage.Active);

  readonly prechatForm = this.fb.group({
    displayName: [''],
    phone: ['']
  });

  readonly messageForm = this.fb.group({
    content: ['', [Validators.required, Validators.minLength(1)]]
  });

  private readonly socketSubscriptions: Subscription[] = [];
  private readonly activeSubscriptions: Subscription[] = [];
  private readonly fingerprint = this.ensureFingerprint();
  private session!: StoredCustomerSession;
  private readonly activeConversationKey = 'customer-chat-active-conversation';

  ngOnInit(): void {
    this.session = this.ensureSession();
    this.prechatForm.patchValue({
      displayName: this.session.displayName,
      phone: this.session.phone ?? ''
    });
    this.setComposerEnabled(false);
    this.openWidget();
    this.restoreActiveConversation();
  }

  ngAfterViewInit(): void {
    this.scrollHistoryToBottom();
    this.historyContainers?.changes.subscribe(() => this.scrollHistoryToBottom());
  }

  ngOnDestroy(): void {
    this.clearSocketSubscriptions();
    this.clearActiveSubscriptions();
    this.socket.disconnect();
  }

  openWidget(): void {
    if (!this.isWidgetOpen()) {
      this.isWidgetOpen.set(true);
    }
    if (this.stage() === ChatStage.Idle) {
      this.stage.set(ChatStage.Confirm);
    }
  }

  closeWidget(): void {
    this.isWidgetOpen.set(false);
  }

  startConversation(): void {
    if (this.stage() === ChatStage.Connecting) {
      return;
    }
    this.errorText.set(null);
    this.stage.set(ChatStage.Connecting);
    this.statusText.set('Connecting you with our support team...');

    const displayName =
      this.prechatForm.controls.displayName.value?.trim() ||
      this.session.displayName ||
      'Visitor';
    const phone = this.prechatForm.controls.phone.value?.trim() || this.session.phone || '';
    this.session = { ...this.session, displayName, phone };
    this.persistSession();

    const payload: CreateConversationPayload = {
      channel: 'web',
      displayName,
      phone
    };

    const start$ = this.api
      .createConversation(payload, this.session.token, displayName)
      .pipe(
        take(1),
        switchMap((conversation) => {
          const customerId = conversation.customer?.id ?? this.session.token;
          this.participantId.set(customerId);
          this.conversation.set(conversation);
          this.persistActiveConversation(conversation, customerId, this.queueStatus());
          this.messages.set([
            this.createSystemMessage(
              conversation.id,
              'Please wait, our support agent will join you shortly.'
            )
          ]);
          this.scrollHistoryToBottom();
          this.statusText.set('We are finding the best available agent for you.');
          this.stage.set(ChatStage.Waiting);
          this.setComposerEnabled(false);
          this.connectSocket(conversation, customerId);
          return this.api
            .requestAgent(conversation.id, conversation.attributes?.channel as string | undefined ?? 'web')
            .pipe(
              catchError((error) => {
                console.error(error);
                this.errorText.set(this.resolveErrorMessage(error, 'Unable to place you in the queue.'));
                this.stage.set(ChatStage.Confirm);
                this.statusText.set(this.greetingText);
                this.setComposerEnabled(false);
                return of<QueueStatusResponse | null>(null);
              })
            );
        }),
        catchError((error) => {
          console.error(error);
          this.errorText.set(this.resolveErrorMessage(error, 'Unable to start a conversation right now.'));
          this.stage.set(ChatStage.Confirm);
          this.statusText.set(this.greetingText);
          this.setComposerEnabled(false);
          return of<QueueStatusResponse | null>(null);
        }),
        finalize(() => {
          if (this.stage() === ChatStage.Connecting) {
            this.stage.set(ChatStage.Confirm);
          }
        })
      );

    this.activeSubscriptions.push(
      start$.subscribe((queueStatus) => {
        if (queueStatus) {
          this.queueStatus.set(queueStatus);
          const conversation = this.conversation();
          const customerId = this.participantId();
          if (conversation && customerId) {
            this.persistActiveConversation(conversation, customerId, queueStatus);
          }
        }
      })
    );
  }

  sendMessage(): void {
    if (!this.canSendMessages()) {
      return;
    }

    if (this.messageForm.invalid) {
      this.messageForm.markAllAsTouched();
      return;
    }

    const content = this.messageForm.value.content?.trim();
    const conversation = this.conversation();
    if (!content || !conversation) {
      return;
    }

    this.isSending.set(true);
    this.socket
      .sendMessage(conversation.id, content)
      .then(() => {
        this.messageForm.reset();
      })
      .catch((error) => {
        console.error(error);
        this.errorText.set(error.message ?? 'Failed to send your message.');
      })
      .finally(() => {
        this.isSending.set(false);
      });
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    event.preventDefault();
    this.sendMessage();
  }

  restartChat(autoStart = false): void {
    this.socket.disconnect();
    this.clearSocketSubscriptions();
    this.clearActiveSubscriptions();
    this.messages.set([]);
    this.queueStatus.set(null);
    this.conversation.set(null);
    this.participantId.set(null);
    this.statusText.set(this.greetingText);
    this.errorText.set(null);
    this.stage.set(ChatStage.Confirm);
    this.setComposerEnabled(false);
    this.clearStoredActiveConversation();
    if (autoStart) {
      this.runAfterDomUpdate(() => this.startConversation());
    }
  }

  private resetToPrechat(message?: string): void {
    this.socket.disconnect();
    this.clearSocketSubscriptions();
    this.clearActiveSubscriptions();
    this.messages.set([]);
    this.queueStatus.set(null);
    this.conversation.set(null);
    this.participantId.set(null);
    this.stage.set(ChatStage.Confirm);
    this.statusText.set(this.greetingText);
    this.setComposerEnabled(false);
    this.clearStoredActiveConversation();
    if (message) {
      this.errorText.set(message);
    }
  }

  closeConversation(): void {
    if (this.isSending()) {
      return;
    }
    const conversation = this.conversation();
    const customerId = this.participantId();
    if (!conversation || !customerId) {
      return;
    }

    this.isSending.set(true);
    this.api
      .closeConversation(conversation.id, customerId)
      .pipe(
        take(1),
        catchError((error) => {
          console.error(error);
          this.errorText.set(this.resolveErrorMessage(error, 'Unable to close the conversation right now.'));
          return of<ConversationMetadata | null>(null);
        }),
        finalize(() => this.isSending.set(false))
      )
      .subscribe((result) => {
        if (!result) {
          return;
        }
        this.socket.disconnect();
        this.clearSocketSubscriptions();
        this.clearActiveSubscriptions();
        this.clearStoredActiveConversation();
        this.stage.set(ChatStage.Ended);
        this.statusText.set('Chat ended. Start a new chat if you need more help.');
        this.setComposerEnabled(false);
      });
  }

  trackByMessageId(_index: number, item: ChatMessage): string {
    return item.id;
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

  renderSenderLabel(message: ChatMessage): string {
    const senderType = message.sender?.type?.toUpperCase();
    const displayName = message.sender?.displayName;
    switch (senderType) {
      case 'AGENT':
        return `${displayName || 'Agent'} (Agent)`;
      case 'CUSTOMER':
        if (message.sender?.id === this.participantId()) {
          return 'You';
        }
        return `${displayName || 'Customer'} (Customer)`;
      case 'SYSTEM':
        return 'System';
      default:
        return displayName || 'Participant';
    }
  }

  formatEstimate(duration?: string | null): string | null {
    if (!duration) {
      return null;
    }
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) {
      return duration;
    }
    const [, hours, minutes, seconds] = match;
    const parts: string[] = [];
    if (hours) {
      parts.push(`${hours}h`);
    }
    if (minutes) {
      parts.push(`${minutes}m`);
    }
    if (seconds && !hours && !minutes) {
      parts.push(`${seconds}s`);
    }
    return parts.length ? parts.join(' ') : '<1m';
  }

  private connectSocket(conversation: ConversationMetadata, customerId: string): void {
    this.setComposerEnabled(false);
    this.socket.connectCustomer({
      conversationId: conversation.id,
      customerId,
      displayName: conversation.customer?.displayName ?? this.session.displayName,
      fingerprint: this.fingerprint
    });
    this.attachSocketListeners();
  }

  private attachSocketListeners(): void {
    this.clearSocketSubscriptions();

    this.socketSubscriptions.push(
      this.socket.onHandshake().subscribe((handshake: SocketHandshake) => {
        this.conversation.set(handshake.conversation);
        this.participantId.set(handshake.participant.id);
        this.persistActiveConversation(handshake.conversation, handshake.participant.id);
        this.persistSession();
        this.loadHistory(handshake.conversation.id);
      })
    );

    this.socketSubscriptions.push(
      this.socket.onMessage().subscribe((message) => this.handleIncomingMessage(message))
    );

    this.socketSubscriptions.push(
      this.socket.onError().subscribe((error) => {
        this.errorText.set(error);
        if (this.stage() === ChatStage.Waiting || this.stage() === ChatStage.Connecting) {
          this.resetToPrechat(error);
        }
      })
    );

    this.socketSubscriptions.push(
      this.socket.onDisconnect().subscribe(() => {
        if (this.stage() !== ChatStage.Idle && this.stage() !== ChatStage.Ended) {
          this.stage.set(ChatStage.Ended);
          this.statusText.set('The chat was closed. We are always here if you need more help.');
          this.setComposerEnabled(false);
        }
      })
    );
  }

  private handleIncomingMessage(message: ChatMessage): void {
    const senderType = message.sender?.type?.toUpperCase();
    const messageType = message.type?.toUpperCase();
    const metadata = message.metadata || {};
    const conversation = this.conversation();

    let normalized: ChatMessage = message;

    if (senderType === 'AGENT') {
      this.stage.set(ChatStage.Active);
      this.queueStatus.set(null);
      const agentName = message.sender?.displayName || conversation?.agent?.displayName || 'our agent';
      this.statusText.set(`You're now chatting with ${agentName} (Agent).`);
      this.setComposerEnabled(true);
    }

    if (messageType === 'SYSTEM') {
      const event = typeof metadata['event'] === 'string' ? metadata['event'].toUpperCase() : null;
      if (event === 'CHAT_CLOSED') {
        const closedByType =
          typeof metadata['closedByType'] === 'string' ? metadata['closedByType'].toUpperCase() : '';
        let display: string;
        if (closedByType === 'CUSTOMER') {
          display = 'You ended the chat. Start a new chat if you need more help.';
        } else if (closedByType === 'AGENT') {
          const agentName =
            (typeof metadata['closedByDisplayName'] === 'string' && metadata['closedByDisplayName'].toString().trim()) ||
            conversation?.agent?.displayName ||
            'The agent';
        display = `${agentName} (Agent) ended the chat.`;
        } else {
          display = 'Chat ended. Start a new chat if you need more help.';
        }
        normalized = { ...message, content: display };
        this.stage.set(ChatStage.Ended);
        this.statusText.set(display);
        this.setComposerEnabled(false);
        this.socket.disconnect();
        this.clearSocketSubscriptions();
        this.clearActiveSubscriptions();
        this.clearStoredActiveConversation();
      } else {
        const closing = message.content?.trim()
          ? message.content
          : 'Thanks for chatting with us! Feel free to start a new conversation whenever you need help.';
        normalized = { ...message, content: closing };
        this.stage.set(ChatStage.Ended);
        this.statusText.set(closing);
        this.setComposerEnabled(false);
        this.socket.disconnect();
        this.clearSocketSubscriptions();
        this.clearActiveSubscriptions();
        this.clearStoredActiveConversation();
      }
    }

    this.messages.update((current) => this.mergeMessages(current, [normalized]));
    this.scrollHistoryToBottom('smooth');
  }

  private loadHistory(conversationId: string): void {
    this.activeSubscriptions.push(
      this.api
        .listMessages(conversationId)
        .pipe(
          take(1),
          catchError((error) => {
            console.error(error);
            this.errorText.set(this.resolveErrorMessage(error, 'Unable to load the previous messages.'));
            return of<ChatMessage[]>([]);
          })
        )
        .subscribe((history) => {
          if (!history.length) {
            this.stage.set(ChatStage.Waiting);
            this.statusText.set('We are finding the best available agent for you.');
            const conversation = this.conversation();
            if (conversation) {
              this.messages.set([
                this.createSystemMessage(
                  conversation.id,
                  'Please wait, our support agent will join you shortly.'
                )
              ]);
            }
            return;
          }
          this.messages.update((current) => this.mergeMessages(current, history));
          if (history.some((msg) => msg.sender?.type?.toUpperCase() === 'AGENT')) {
            this.stage.set(ChatStage.Active);
            this.setComposerEnabled(true);
          } else {
            this.stage.set(ChatStage.Waiting);
            this.statusText.set('We are finding the best available agent for you.');
          }
          this.scrollHistoryToBottom();
        })
    );
  }

  private mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    const byId = new Map<string, ChatMessage>();
    [...existing, ...incoming].forEach((msg) => {
      byId.set(msg.id, msg);
    });
    return Array.from(byId.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private clearSocketSubscriptions(): void {
    while (this.socketSubscriptions.length) {
      this.socketSubscriptions.pop()?.unsubscribe();
    }
  }

  private clearActiveSubscriptions(): void {
    while (this.activeSubscriptions.length) {
      this.activeSubscriptions.pop()?.unsubscribe();
    }
  }

  private createSystemMessage(conversationId: string, content: string): ChatMessage {
    return {
      id: `local-${Date.now()}`,
      conversationId,
      type: 'SYSTEM',
      content,
      timestamp: new Date().toISOString(),
      sender: {
        id: 'system',
        type: 'SYSTEM',
        displayName: 'System'
      }
    };
  }

  private ensureFingerprint(): string {
    const storageKey = 'customer-chat-fingerprint';
    try {
      const existing = localStorage.getItem(storageKey);
      if (existing) {
        return existing;
      }
    } catch (error) {
      console.warn('Unable to read fingerprint from storage', error);
    }
    const generated = this.generateUuid();
    try {
      localStorage.setItem(storageKey, generated);
    } catch (error) {
      console.warn('Unable to store fingerprint', error);
    }
    return generated;
  }

  private ensureSession(): StoredCustomerSession {
    const storageKey = 'customer-chat-session';
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredCustomerSession;
        if (parsed.token) {
          return parsed;
        }
      }
    } catch (error) {
      console.warn('Failed to restore stored session', error);
    }
    const session: StoredCustomerSession = {
      token: this.generateUuid(),
      displayName: 'Visitor',
      phone: ''
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(session));
    } catch (error) {
      console.warn('Unable to persist session details', error);
    }
    return session;
  }

  private resolveErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse) {
      const resolved = this.resolveHttpError(error);
      if (resolved) {
        return resolved;
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
      return 'We’re having trouble reaching our servers. Please check your connection and try again.';
    }

    switch (error.status) {
      case 401:
      case 403:
        return 'We could not verify your session. Please restart the chat.';
      case 404:
        return 'This chat is no longer available. Please start a new conversation.';
      case 409:
        return 'Another agent is already helping with this conversation.';
      case 422:
        return 'We could not process your request. Try again in a moment.';
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

  private setComposerEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.messageForm.disabled) {
        this.messageForm.enable({ emitEvent: false });
      }
    } else if (this.messageForm.enabled) {
      this.messageForm.disable({ emitEvent: false });
    }
  }

  private restoreActiveConversation(): void {
    const stored = this.readStoredActiveConversation();
    if (!stored) {
      return;
    }

    try {
      if (!stored.conversation || stored.conversation.status === 'CLOSED') {
        this.clearStoredActiveConversation();
        return;
      }
      this.isWidgetOpen.set(true);
      this.stage.set(ChatStage.Waiting);
      this.statusText.set('Restoring your conversation...');
      this.queueStatus.set(stored.queueStatus ?? null);
      const placeholder = this.createSystemMessage(
        stored.conversation.id,
        'Please wait, our support agent will join you shortly.'
      );
      this.messages.set([placeholder]);
      this.conversation.set(stored.conversation);
      this.participantId.set(stored.customerId);
      this.setComposerEnabled(false);
      this.connectSocket(stored.conversation, stored.customerId);
    } catch (error) {
      console.warn('Unable to restore customer conversation', error);
      this.clearStoredActiveConversation();
    }
  }

  private persistActiveConversation(
    conversation: ConversationMetadata,
    customerId: string,
    queueStatus: QueueStatusResponse | null = this.queueStatus()
  ): void {
    try {
      const state: StoredConversationState = {
        conversation,
        customerId,
        queueStatus
      };
      localStorage.setItem(this.activeConversationKey, JSON.stringify(state));
    } catch (error) {
      console.warn('Unable to persist active conversation', error);
    }
  }

  private persistSession(): void {
    try {
      const storageKey = 'customer-chat-session';
      localStorage.setItem(storageKey, JSON.stringify(this.session));
    } catch (error) {
      console.warn('Unable to persist session details', error);
    }
  }

  private clearStoredActiveConversation(): void {
    try {
      localStorage.removeItem(this.activeConversationKey);
    } catch (error) {
      console.warn('Unable to clear stored conversation', error);
    }
  }

  private readStoredActiveConversation(): StoredConversationState | null {
    try {
      const raw = localStorage.getItem(this.activeConversationKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as StoredConversationState;
      if (parsed?.conversation?.id && parsed?.customerId) {
        return parsed;
      }
    } catch (error) {
      console.warn('Failed to parse stored conversation', error);
    }
    return null;
  }

  private runAfterDomUpdate(task: () => void): void {
    requestAnimationFrame(() => requestAnimationFrame(task));
  }

  private scrollHistoryToBottom(behavior: ScrollBehavior = 'auto'): void {
    this.runAfterDomUpdate(() => {
      const container =
        this.historyContainers && this.historyContainers.length ? this.historyContainers.last?.nativeElement : undefined;
      if (!container) {
        return;
      }
      container.scrollTo({ top: container.scrollHeight, behavior });
    });
  }

  private generateUuid(): string {
    const cryptoObj: Crypto | undefined = globalThis.crypto;

    if (cryptoObj?.randomUUID) {
      return cryptoObj.randomUUID();
    }

    if (cryptoObj?.getRandomValues) {
      const buffer = new Uint8Array(16);
      cryptoObj.getRandomValues(buffer);

      buffer[6] = (buffer[6] & 0x0f) | 0x40;
      buffer[8] = (buffer[8] & 0x3f) | 0x80;

      const hex = Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16;
      const value = char === 'x' ? random : (random & 0x3) | 0x8;
      return Math.floor(value).toString(16);
    });
  }
}
