import { bootstrapApplication } from '@angular/platform-browser';
import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';


// ==================================================
// MESSAGE TYPES
// ==================================================

interface ChatMessageData {
  id?: string;
  name: string;
  message?: string;
  text?: string;
  time: string;
  replyToId?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
}

interface ChatMessage {
  id?: string;
  name: string;
  text: string;
  time: string;
  mine?: boolean;

  // Reply information
  replyToId?: string | null;
  replyTo?: ChatMessage | null;

  // Message delivery state
  status?: 'sent' | 'delivered' | 'read';

  // Persisted receipt timestamps
  deliveredAt?: string | null;
  readAt?: string | null;
}


interface PresenceData {
  name: string;
  online: boolean;
  lastSeen?: string | null;
}

interface MessageReceiptData {
  id: string;
}



// ==================================================
// APP COMPONENT
// ==================================================

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],

  template: `
  <div class="shell">

    @if (!joined()) {

      <section class="welcome glass">

        <div class="logo">♥</div>

        <p class="eyebrow">JUST US</p>

        <h1>Our little corner</h1>

        <p class="sub">
          A secret place for our messages.
        </p>

        <form (ngSubmit)="join()">

          <input
            [(ngModel)]="name"
            name="name"
            maxlength="24"
            placeholder="Your name"
            autocomplete="off"
            autofocus
            required
          >

          <input
            [(ngModel)]="passcode"
            name="passcode"
            type="password"
            maxlength="50"
            placeholder="Passcode"
            autocomplete="off"
            required
          >

          <button type="submit">
            Enter chat <span>→</span>
          </button>

        </form>

        @if (loginError()) {
          <p class="login-error">
            {{ loginError() }}
          </p>
        }

      </section>

    } @else {

      <section class="chat glass">

        <!-- ==========================================
             HEADER
        =========================================== -->

        <header>

  <div class="avatar">♥</div>

  <div class="head-text">

    <h2>My Love</h2>

    <span [class.offline]="!peerOnline()">
      <i></i>
      {{ peerOnline() ? (typing() || 'Online') : lastSeenText() }}
    </span>

  </div>

</header>


        <!-- ==========================================
             MESSAGES
        =========================================== -->

        <main
          class="messages"
          (click)="clearReply()"
        >

          @for (item of messages(); track item.id || $index) {

            @if (shouldShowDateSeparator(item, $index)) {

              <div class="date-pill">
                {{ getDateSeparatorText(item.time) }}
              </div>

            }

            @if (item.name === '__system') {

              <div class="system">
                {{ item.text }}
              </div>

            } @else {

              <div
                class="row"
                [class.mine]="item.mine"
                (click)="$event.stopPropagation(); handleMessageClick($event, item)"
              >

                <div
                  class="bubble"
                  [class.reply-bubble]="item.replyTo"
                >

                  <!-- ==================================
                       REPLIED MESSAGE PREVIEW
                  =================================== -->

                  @if (item.replyTo) {

                    <div
                      class="reply-preview"
                      (click)="scrollToMessage(item.replyToId); $event.stopPropagation()"
                    >

                      <div class="reply-line"></div>

                      <div class="reply-content">

                        <strong>
                          {{ item.replyTo.mine ? 'You' : item.replyTo.name }}
                        </strong>

                        <span>
                          {{ item.replyTo.text }}
                        </span>

                      </div>

                    </div>

                  }


                  @if (!item.mine) {

                    <small>
                      {{ item.name }}
                    </small>

                  }


                  <div class="message-text">
                    {{ item.text }}
                  </div>


                  <time>

                    {{ formatTime(item.time) }}

                    @if (item.mine) {

                      <span
                        class="message-status"
                        [class.read]="item.status === 'read'"
                      >

                        @if (item.status === 'sent') {
                          ✓
                        } @else {
                          ✓✓
                        }

                      </span>

                    }

                  </time>

                </div>

              </div>

            }

          }

        </main>


        <!-- ==========================================
             REPLY BAR
        =========================================== -->

        @if (replyingTo()) {

          <div class="reply-composer">

            <div class="reply-composer-line"></div>

            <div class="reply-composer-content">

              <strong>
                Replying to
                {{ replyingTo()!.mine ? 'yourself' : replyingTo()!.name }}
              </strong>

              <span>
                {{ replyingTo()!.text }}
              </span>

            </div>

            <button
              type="button"
              class="reply-close"
              aria-label="Cancel reply"
              (click)="clearReply()"
            >
              ×
            </button>

          </div>

        }


        <!-- ==========================================
             COMPOSER
        =========================================== -->

        <form
          class="composer"
          (ngSubmit)="send()"
        >

          <input
            [(ngModel)]="draft"
            name="draft"
            maxlength="2000"
            placeholder="Write something…"
            autocomplete="off"
            (input)="handleTyping()"
          >

          <button
            type="submit"
            [disabled]="!draft.trim() || !online()"
            aria-label="Send"
          >
            ↑
          </button>

        </form>

      </section>

    }

  </div>
  `,

  styles: [`


    /* ==============================================
       LOGIN ERROR
    =============================================== */

    .login-error {
      margin: 14px 0 0;
      color: #c05270;
      font-size: 12px;
      font-weight: 600;
    }


    /* ==============================================
       PRESENCE
    =============================================== */

    .presence-text {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .presence-text i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #55b985;
      display: inline-block;
      flex: 0 0 auto;
    }

    .presence-text.offline i {
      background: #b7aeb2;
    }


    /* ==============================================
       MESSAGE STATUS
    =============================================== */

    .message-status {
      display: inline-block;
      margin-left: 3px;
      font-size: 11px;
      letter-spacing: -2px;
      opacity: .75;
    }

    .message-status.read {
      color: #e55d89;
      opacity: 1;
    }


    /* ==============================================
       REPLY PREVIEW INSIDE BUBBLE
    =============================================== */

    .reply-preview {
      display: flex;
      width: 100%;
      margin-bottom: 8px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .35);
      overflow: hidden;
      cursor: pointer;
    }

    .reply-line {
      width: 3px;
      background: #d96b8b;
      flex: 0 0 auto;
    }

    .reply-content {
      min-width: 0;
      display: flex;
      flex-direction: column;
      padding: 6px 8px;
      gap: 2px;
    }

    .reply-content strong {
      font-size: 11px;
      line-height: 14px;
      font-weight: 700;
    }

    .reply-content span {
      font-size: 11px;
      line-height: 15px;
      opacity: .72;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      max-width: 190px;
    }


    /* ==============================================
       REPLY COMPOSER BAR
    =============================================== */

    .reply-composer {
      display: flex;
      align-items: stretch;
      gap: 0;
      padding: 8px 12px;
      background: rgba(255, 247, 250, .96);
      border-top: 1px solid rgba(190, 130, 150, .12);
    }

    .reply-composer-line {
      width: 3px;
      border-radius: 4px;
      background: #d96b8b;
      flex: 0 0 auto;
    }

    .reply-composer-content {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 2px 10px;
      gap: 2px;
    }

    .reply-composer-content strong {
      font-size: 11px;
      color: #b34d6d;
    }

    .reply-composer-content span {
      font-size: 12px;
      color: #75676d;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .reply-close {
      width: 30px;
      height: 30px;
      border: 0;
      background: transparent;
      color: #8d7d83;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      align-self: center;
    }


    /* ==============================================
       MOBILE LONG-PRESS / TOUCH
    =============================================== */

    .bubble {
      user-select: text;
      -webkit-user-select: text;
      touch-action: manipulation;
    }

  `]
})
export class AppComponent implements OnDestroy {


  // ==================================================
  // FIXED PRIVATE ROOM
  // ==================================================

  private readonly roomId =
    'our-private-chat-9x7m2k8p';


  // ==================================================
  // ALLOWED NAMES
  // ==================================================

  private readonly allowedNames = [
    'prashant',
    'manjushree'
  ];



  // ==================================================
  // STATE
  // ==================================================

  joined = signal(false);

  online = signal(false);


  typing = signal('');

  loginError = signal('');

  messages = signal<ChatMessage[]>([]);


  // ==================================================
  // PRESENCE STATE
  // ==================================================

  peerOnline = signal(false);

  peerLastSeen = signal<string | null>(null);


  // ==================================================
  // REPLY STATE
  // ==================================================

  replyingTo =
    signal<ChatMessage | null>(null);


  // ==================================================
  // INPUT
  // ==================================================

  name = '';

  passcode = '';

  draft = '';


  // ==================================================
  // SOCKET / TIMERS
  // ==================================================

  private socket?: Socket;

  private typingTimer?:
    ReturnType<typeof setTimeout>;

  private reconnectTimer?:
    ReturnType<typeof setTimeout>;


  // ==================================================
  // LONG PRESS
  // ==================================================

  private longPressTimer?:
    ReturnType<typeof setTimeout>;

  private longPressTriggered = false;



  // ==================================================
  // JOIN CHAT
  // ==================================================
  // JOIN CHAT
  // ==================================================

  async join() {

    this.name =
      this.name
        .trim()
        .slice(0, 24);


    const normalizedName =
      this.name.toLowerCase();


    // ==================================================
    // NAME VALIDATION
    // ==================================================

    if (!this.name) {

      this.loginError.set(
        'Please enter your name.'
      );

      return;
    }


    if (
      !this.allowedNames.includes(
        normalizedName
      )
    ) {

      this.loginError.set(
        'Only Prashant or Manjushree can enter.'
      );

      return;
    }


    // ==================================================
    // PASSCODE VALIDATION
    // ==================================================

    if (!this.passcode.trim()) {

      this.loginError.set(
        'Please enter the passcode.'
      );

      return;
    }


    this.loginError.set('');

    this.joined.set(true);

    // ==================================================
    // SOCKET CONNECTION
    // ==================================================

    this.socket =
      io();


    // ==================================================
    // CONNECT
    // ==================================================

    this.socket.on(
      'connect',
      () => {

        this.online.set(true);

        this.socket?.emit(
          'join',
          {
            roomId:
              this.roomId,

            name:
              this.name,

            passcode:
              this.passcode
          }
        );

      }
    );


    // ==================================================
    // SOCKET RECONNECT
    // ==================================================

    this.socket.io.on(
      'reconnect',
      () => {

        this.online.set(true);

        this.socket?.emit(
          'join',
          {
            roomId:
              this.roomId,

            name:
              this.name,

            passcode:
              this.passcode
          }
        );

      }
    );


    // ==================================================
    // DISCONNECT
    // ==================================================

    this.socket.on(
      'disconnect',
      () => {

        this.online.set(false);

      }
    );



    // ==================================================
    // CHAT HISTORY
    // ==================================================

    this.socket.on(
      'history',
      (
        history: ChatMessageData[]
      ) => {

        this.processHistory(history);

      }
    );


    // ==================================================
    // NEW MESSAGE
    // ==================================================

    this.socket.on(
      'message',
      (
        message: ChatMessageData
      ) => {

        this.processIncomingMessage(message);

      }
    );


    // ==================================================
    // MESSAGE DELIVERED
    // ==================================================

    this.socket.on(
      'messageDelivered',
      (
        data: MessageReceiptData
      ) => {

        if (!data?.id) {
          return;
        }


        this.messages.update(
          list =>
            list.map(
              message => {

                if (
                  message.id !==
                  data.id
                ) {
                  return message;
                }


                if (!message.mine) {
                  return message;
                }


                // Don't downgrade read
                // back to delivered.
                if (
                  message.status ===
                  'read'
                ) {
                  return message;
                }


                return {
                  ...message,
                  status:
                    'delivered',
                  deliveredAt:
                    message.deliveredAt ||
                    new Date().toISOString()
                };

              }
            )
        );

      }
    );


    // ==================================================
    // MESSAGE READ
    // ==================================================

    this.socket.on(
      'messageRead',
      (
        data: MessageReceiptData
      ) => {

        if (!data?.id) {
          return;
        }


        this.messages.update(
          list =>
            list.map(
              message => {

                if (
                  message.id !==
                  data.id
                ) {
                  return message;
                }


                if (!message.mine) {
                  return message;
                }


                return {
                  ...message,
                  status:
                    'read',
                  deliveredAt:
                    message.deliveredAt ||
                    new Date().toISOString(),
                  readAt:
                    new Date().toISOString()
                };

              }
            )
        );

      }
    );


    // ==================================================
    // SYSTEM MESSAGE
    // ==================================================

    this.socket.on(
      'system',
      (
        text: string
      ) => {

        this.messages.update(
          list => [
            ...list,

            {
              name:
                '__system',

              text,

              time:
                ''
            }
          ]
        );


        this.scrollSoon();

      }
    );


    // ==================================================
    // PRESENCE
    // ==================================================

    this.socket.on(
      'presence',
      (
        data: PresenceData
      ) => {

        if (
          !data ||
          !data.name
        ) {
          return;
        }


        // Ignore our own presence.
        if (
          data.name.toLowerCase() ===
          this.name.toLowerCase()
        ) {
          return;
        }


        this.peerOnline.set(
          !!data.online
        );


        this.peerLastSeen.set(
          data.lastSeen ||
          null
        );

      }
    );


    // ==================================================
    // TYPING
    // ==================================================

    this.socket.on(
      'typing',
      (
        who: string
      ) => {

        if (
          who.toLowerCase() ===
          this.name.toLowerCase()
        ) {
          return;
        }


        this.typing.set(
          `${who} is typing…`
        );


        clearTimeout(
          this.typingTimer
        );


        this.typingTimer =
          setTimeout(
            () =>
              this.typing.set(''),
            1400
          );

      }
    );


    // ==================================================
    // STOP TYPING
    // ==================================================

    this.socket.on(
      'stopTyping',
      () => {

        this.typing.set('');

      }
    );


    // ==================================================
    // JOIN ERROR
    // ==================================================

    this.socket.on(
      'joinError',
      (
        error: string
      ) => {

        console.error(
          'Join error:',
          error
        );


        this.joined.set(false);

        this.online.set(false);

        this.peerOnline.set(false);




        this.loginError.set(
          error ||
          'Unable to enter the chat.'
        );


        this.socket?.disconnect();

      }
    );

  }


  // ==================================================
  // PROCESS INCOMING MESSAGE
  // ==================================================

  private processIncomingMessage(
    message: ChatMessageData
  ) {

    const mine =
      message.name.toLowerCase() ===
      this.name.toLowerCase();

    const text =
      typeof message.message === 'string'
        ? message.message
        : (message.text || '');

    const replyTo =
      message.replyToId
        ? this.findMessageById(
          message.replyToId
        )
        : null;

    const chatMessage: ChatMessage = {

      id:
        message.id,

      name:
        message.name,

      text,

      time:
        message.time,

      mine,

      replyToId:
        message.replyToId || null,

      replyTo,

      status:
        mine
          ? 'sent'
          : 'delivered',

      deliveredAt:
        mine
          ? null
          : new Date().toISOString(),

      readAt:
        mine
          ? null
          : new Date().toISOString()

    };

    this.messages.update(
      list => [
        ...list,
        chatMessage
      ]
    );

    this.scrollSoon();

    if (
      !mine &&
      message.id
    ) {

      this.socket?.emit(
        'messageDelivered',
        {
          id:
            message.id
        }
      );

      this.socket?.emit(
        'messageRead',
        {
          id:
            message.id
        }
      );

    }

  }


  // ==================================================
  // PROCESS HISTORY
  // ==================================================

  private processHistory(
    history: ChatMessageData[]
  ) {

    const chatMessages: ChatMessage[] =
      history.map(
        message => {

          const mine =
            message.name.toLowerCase() ===
            this.name.toLowerCase();

          return {

            id:
              message.id,

            name:
              message.name,

            text:
              typeof message.message === 'string'
                ? message.message
                : (message.text || ''),

            time:
              message.time,

            mine,

            replyToId:
              message.replyToId || null,

            replyTo:
              null,

            deliveredAt:
              message.deliveredAt || null,

            readAt:
              message.readAt || null,

            status:
              mine
                ? (
                  message.readAt
                    ? 'read'
                    : message.deliveredAt
                      ? 'delivered'
                      : 'sent'
                )
                : 'read'

          };

        }
      );

    // Resolve replies after all messages exist.
    for (
      const message of chatMessages
    ) {

      if (
        message.replyToId
      ) {

        message.replyTo =
          chatMessages.find(
            original =>
              original.id ===
              message.replyToId
          ) || null;

      }

    }

    this.messages.set(
      chatMessages
    );

    this.scrollSoon();

    // Mark received history as read.
    for (
      const message of chatMessages
    ) {

      if (
        !message.mine &&
        message.id
      ) {

        this.socket?.emit(
          'messageDelivered',
          {
            id:
              message.id
          }
        );

        this.socket?.emit(
          'messageRead',
          {
            id:
              message.id
          }
        );

      }

    }

  }


  // ==================================================
  // SEND MESSAGE
  // ==================================================

  send() {

    const text =
      this.draft.trim();

    if (
      !text ||
      !this.socket ||
      !this.online()
    ) {
      return;
    }

    const reply =
      this.replyingTo();

    const replyToId =
      reply?.id ||
      null;

    this.socket.emit(
      'message',
      {
        text,

        replyToId
      }
    );

    this.socket.emit(
      'stopTyping'
    );

    this.draft = '';

    this.replyingTo.set(
      null
    );

  }


  // ==================================================
  // TYPING HANDLER
  // ==================================================

  handleTyping() {

    if (
      !this.socket ||
      !this.online()
    ) {
      return;
    }


    this.socket.emit(
      'typing'
    );


    clearTimeout(
      this.typingTimer
    );


    this.typingTimer =
      setTimeout(
        () => {

          this.socket?.emit(
            'stopTyping'
          );

        },

        900
      );

  }


  // ==================================================
  // MESSAGE CLICK / LONG PRESS
  // ==================================================

  handleMessageClick(
    event: MouseEvent,
    message: ChatMessage
  ) {

    // Don't reply to system messages.
    if (
      message.name ===
      '__system'
    ) {
      return;
    }


    // Desktop click.
    if (
      event.detail === 1
    ) {

      this.startLongPress(
        message
      );

      return;

    }


    // Double click can also reply.
    if (
      event.detail >= 2
    ) {

      this.cancelLongPress();

      this.setReply(
        message
      );

    }

  }


  // ==================================================
  // LONG PRESS SUPPORT
  // ==================================================

  private startLongPress(
    message: ChatMessage
  ) {

    this.cancelLongPress();

    this.longPressTriggered =
      false;


    this.longPressTimer =
      setTimeout(
        () => {

          this.longPressTriggered =
            true;

          this.setReply(
            message
          );

        },

        550
      );

  }


  private cancelLongPress() {

    if (
      this.longPressTimer
    ) {

      clearTimeout(
        this.longPressTimer
      );

      this.longPressTimer =
        undefined;

    }

  }


  // ==================================================
  // SET REPLY
  // ==================================================

  private setReply(
    message: ChatMessage
  ) {

    this.replyingTo.set(
      message
    );


    setTimeout(
      () => {

        const input =
          document.querySelector(
            '.composer input'
          ) as HTMLInputElement |
          null;


        input?.focus();

      }
    );

  }


  // ==================================================
  // CLEAR REPLY
  // ==================================================

  clearReply() {

    this.replyingTo.set(
      null
    );

  }


  // ==================================================
  // FIND MESSAGE
  // ==================================================

  private findMessageById(
    id: string
  ): ChatMessage | null {

    return (
      this.messages().find(
        message =>
          message.id === id
      ) || null
    );

  }


  // ==================================================
  // SCROLL TO MESSAGE
  // ==================================================

  scrollToMessage(
    id?: string | null
  ) {

    if (!id) {
      return;
    }


    setTimeout(
      () => {

        const messages =
          this.messages();


        const index =
          messages.findIndex(
            message =>
              message.id === id
          );


        if (
          index < 0
        ) {
          return;
        }


        const elements =
          document.querySelectorAll(
            '.row'
          );


        const element =
          elements[
          index
          ] as HTMLElement |
          undefined;


        element?.scrollIntoView({
          behavior:
            'smooth',

          block:
            'center'
        });

      }
    );

  }


  // ==================================================
  // DATE SEPARATOR
  // ==================================================

  shouldShowDateSeparator(
    message: ChatMessage,
    index: number
  ): boolean {

    if (!message.time) {
      return false;
    }

    if (index === 0) {
      return true;
    }

    let previous: ChatMessage | undefined;

    for (let i = index - 1; i >= 0; i--) {
      const candidate = this.messages()[i];

      if (candidate?.time) {
        previous = candidate;
        break;
      }
    }

    if (!previous) {
      return true;
    }

    return !this.isSameCalendarDay(
      message.time,
      previous.time
    );

  }


  getDateSeparatorText(
    time: string
  ): string {

    const date = new Date(time);

    if (isNaN(date.getTime())) {
      return '';
    }

    const today = new Date();
    const yesterday = new Date();

    yesterday.setDate(
      yesterday.getDate() - 1
    );

    if (this.isSameCalendarDay(time, today.toISOString())) {
      return 'Today';
    }

    if (this.isSameCalendarDay(time, yesterday.toISOString())) {
      return 'Yesterday';
    }

    return date.toLocaleDateString(
      'en-IN',
      {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }
    );

  }


  private isSameCalendarDay(
    firstTime: string,
    secondTime: string
  ): boolean {

    const first = new Date(firstTime);
    const second = new Date(secondTime);

    if (
      isNaN(first.getTime()) ||
      isNaN(second.getTime())
    ) {
      return false;
    }

    return (
      first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate()
    );

  }


  // ==================================================
  // LAST SEEN TEXT
  // ==================================================

  lastSeenText(): string {

    const lastSeen =
      this.peerLastSeen();


    if (!lastSeen) {
      return 'Offline';
    }


    const date =
      new Date(
        lastSeen
      );


    if (
      isNaN(
        date.getTime()
      )
    ) {

      return 'Offline';

    }


    return `Last seen ${this.formatTime(
      lastSeen
    )}`;

  }


  // ==================================================
  // WHATSAPP STYLE TIME
  // ==================================================

  formatTime(
    time: string
  ): string {

    if (!time) {
      return '';
    }


    const date =
      new Date(
        time
      );


    if (
      isNaN(
        date.getTime()
      )
    ) {

      return time;

    }


    return date.toLocaleTimeString(
      'en-IN',
      {
        hour:
          'numeric',

        minute:
          '2-digit',

        hour12:
          true
      }
    );

  }


  // ==================================================
  // AUTO SCROLL
  // ==================================================

  private scrollSoon() {

    setTimeout(
      () => {

        const el =
          document.querySelector(
            '.messages'
          ) as HTMLElement |
          null;


        if (el) {

          el.scrollTop =
            el.scrollHeight;

        }

      }
    );

  }


  // ==================================================
  // CLEANUP
  // ==================================================

  ngOnDestroy() {

    clearTimeout(
      this.typingTimer
    );


    clearTimeout(
      this.reconnectTimer
    );


    this.cancelLongPress();


    this.socket?.disconnect();

  }

}


// ==================================================
// BOOTSTRAP
// ==================================================

bootstrapApplication(
  AppComponent
).catch(
  console.error
);