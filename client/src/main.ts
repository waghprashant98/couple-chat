import { bootstrapApplication } from '@angular/platform-browser';
import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';


// ==================================================
// MESSAGE TYPES
// ==================================================

interface EncryptedMessage {
  id?: string;
  name: string;
  ciphertext: string;
  iv: string;
  time: string;
  mine?: boolean;
  replyToId?: string | null;
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
}

interface PublicKeyData {
  name: string;
  key: JsonWebKey;
}

interface PresenceData {
  name: string;
  online: boolean;
  lastSeen?: string | null;
}

interface MessageReceiptData {
  id: string;
}

interface KeyBundleData {
  ciphertext: string;
  iv: string;
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

            <span
              class="presence-text"
              [class.offline]="!peerOnline()"
            >
              <i></i>

              @if (typing()) {
                {{ typing() }}
              } @else if (peerOnline()) {
                Online
              } @else {
                {{ lastSeenText() }}
              }

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

          <div class="date-pill">
            Today
          </div>


          @for (item of messages(); track item.id || $index) {

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
            [disabled]="!draft.trim() || !online() || !encryptionReady()"
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
  // E2E STORAGE
  // ==================================================

  private readonly privateKeyStorage =
    'couple-chat-e2e-private-key';

  private readonly publicKeyStorage =
    'couple-chat-e2e-public-key';


  // ==================================================
  // STATE
  // ==================================================

  joined = signal(false);

  online = signal(false);

  encryptionReady = signal(false);

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
  // E2E KEYS
  // ==================================================

  private privateKey?: CryptoKey;

  private publicKey?: CryptoKey;

  private peerPublicKey?: CryptoKey;

  private encryptionKey?: CryptoKey;

  // Same master key is used on every browser/device.
  // The current ECDH key is used only to migrate the
  // existing working browser's messages.
  private masterKey?: CryptoKey;

  private keyBundleResolved = false;

  private keyBundleExists = false;

  private bundleCreationStarted = false;

  private bundleMigrationAttempts = 0;

  private bundleMigrationTimer?:
    ReturnType<typeof setTimeout>;


  // ==================================================
  // PENDING DATA
  // ==================================================

  private pendingHistory?: EncryptedMessage[];

  private pendingMessages: EncryptedMessage[] = [];


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

    this.masterKey = undefined;
    this.keyBundleResolved = false;
    this.keyBundleExists = false;
    this.bundleCreationStarted = false;

    this.joined.set(true);


    // ==================================================
    // PREPARE E2E KEYS
    // ==================================================

    try {

      await this.prepareEncryptionKeys();

    } catch (error) {

      console.error(
        'E2E key setup failed:',
        error
      );

      this.joined.set(false);

      this.loginError.set(
        'Secure encryption could not be initialized.'
      );

      return;
    }


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

        this.encryptionReady.set(false);

        this.masterKey = undefined;
        this.keyBundleResolved = false;
        this.keyBundleExists = false;
        this.bundleCreationStarted = false;

        this.peerPublicKey =
          undefined;

        this.encryptionKey =
          undefined;

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

        this.encryptionReady.set(false);

        this.encryptionKey =
          undefined;

        this.masterKey =
          undefined;

        this.keyBundleResolved =
          false;

        this.keyBundleExists =
          false;

        this.peerPublicKey =
          undefined;

      }
    );


    // ==================================================
    // SERVER REQUESTED OUR PUBLIC KEY
    // ==================================================

    this.socket.on(
      'requestPublicKey',
      async () => {

        try {

          await this.sendPublicKey();


          // Ask server for saved peer key.
          this.socket?.emit(
            'requestPeerKey'
          );


        } catch (error) {

          console.error(
            'Public key send failed:',
            error
          );

        }

      }
    );


    // ==================================================
    // SHARED KEY BUNDLE
    // ==================================================

    this.socket.on(
      'keyBundle',
      async (
        bundle: KeyBundleData | null
      ) => {

        this.keyBundleResolved = true;

        if (!bundle) {

          this.keyBundleExists = false;

          await this.useLegacyKeyIfReady();

          return;
        }

        this.keyBundleExists = true;

        try {

          const master =
            await this.unwrapMasterKey(
              bundle
            );

          this.masterKey =
            master;

          this.encryptionKey =
            master;

          this.encryptionReady.set(
            true
          );

          await this.processPendingData();

        } catch (error) {

          console.error(
            'Shared key unlock failed:',
            error
          );

          this.encryptionReady.set(
            false
          );

          this.loginError.set(
            'Unable to unlock the chat. Check the passcode.'
          );

        }

      }
    );


    // ==================================================
    // PEER PUBLIC KEY
    // ==================================================

    this.socket.on(
      'peerPublicKey',
      async (
        data: PublicKeyData
      ) => {

        try {

          if (
            !data ||
            !data.key ||
            !data.name
          ) {
            return;
          }


          // Ignore our own key.
          if (
            data.name.toLowerCase() ===
            this.name.toLowerCase()
          ) {
            return;
          }


          this.peerPublicKey =
            await crypto.subtle.importKey(
              'jwk',
              data.key,
              {
                name:
                  'ECDH',

                namedCurve:
                  'P-256'
              },
              true,
              []
            );


          await this.deriveEncryptionKey();

          await this.useLegacyKeyIfReady();


        } catch (error) {

          console.error(
            'Peer key error:',
            error
          );

          this.encryptionReady.set(
            false
          );

          this.encryptionKey =
            undefined;

        }

      }
    );


    // ==================================================
    // KEY BUNDLE SAVED
    // ==================================================

    this.socket.on(
      'keyBundleSaved',
      (
        data: {
          success?: boolean;
          existing?: boolean;
        }
      ) => {

        if (data?.success) {

          this.keyBundleExists = true;

          this.bundleCreationStarted =
            false;

          this.bundleMigrationAttempts =
            0;

          clearTimeout(
            this.bundleMigrationTimer
          );

          this.bundleMigrationTimer =
            undefined;

          return;
        }

        this.bundleCreationStarted =
          false;

        this.retryKeyBundleMigration();

      }
    );


    // ==================================================
    // CHAT HISTORY
    // ==================================================

    this.socket.on(
      'history',
      async (
        history: EncryptedMessage[]
      ) => {

        if (!this.encryptionKey) {

          this.pendingHistory =
            history;

          return;

        }


        await this.processHistory(
          history
        );

      }
    );


    // ==================================================
    // NEW ENCRYPTED MESSAGE
    // ==================================================

    this.socket.on(
      'message',
      async (
        message: EncryptedMessage
      ) => {

        if (!this.encryptionKey) {

          this.pendingMessages.push(
            message
          );

          return;

        }


        await this.processIncomingMessage(
          message
        );

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
                    'delivered'
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
                    'read'
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

        this.encryptionReady.set(
          false
        );

        this.encryptionKey =
          undefined;

        this.peerPublicKey =
          undefined;

        this.pendingHistory =
          undefined;

        this.pendingMessages =
          [];


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

  private async processIncomingMessage(
    message: EncryptedMessage
  ) {

    if (!this.encryptionKey) {

      this.pendingMessages.push(
        message
      );

      return;

    }


    try {

      const decrypted =
        await this.decryptMessage(
          message.ciphertext,
          message.iv
        );


      const parsed =
        this.parseDecryptedMessage(
          decrypted
        );


      const mine =
        message.name.toLowerCase() ===
        this.name.toLowerCase();


      const replyTo =
        parsed.replyToId
          ? this.findMessageById(
              parsed.replyToId
            )
          : null;


      const chatMessage: ChatMessage = {

        id:
          message.id,

        name:
          message.name,

        text:
          parsed.text,

        time:
          message.time,

        mine,

        replyToId:
          parsed.replyToId,

        replyTo,

        status:
          mine
            ? 'sent'
            : 'delivered'

      };


      this.messages.update(
        list => [
          ...list,
          chatMessage
        ]
      );


      this.scrollSoon();


      // ==================================================
      // DELIVERED RECEIPT
      // ==================================================

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


        // Message is visible immediately,
        // so mark it as read.
        this.socket?.emit(
          'messageRead',
          {
            id:
              message.id
          }
        );

      }


    } catch (error) {

      console.error(
        'Incoming message decryption failed:',
        error
      );

    }

  }


  // ==================================================
  // PROCESS / DECRYPT HISTORY
  // ==================================================

  private async processHistory(
    history: EncryptedMessage[]
  ) {

    if (!this.encryptionKey) {

      this.pendingHistory =
        history;

      return;

    }


    const decrypted:
      ChatMessage[] = [];

    let decryptFailed =
      false;


    for (
      const message of history
    ) {

      try {

        const decryptedText =
          await this.decryptMessage(
            message.ciphertext,
            message.iv
          );


        const parsed =
          this.parseDecryptedMessage(
            decryptedText
          );


        const mine =
          message.name.toLowerCase() ===
          this.name.toLowerCase();


        decrypted.push({

          id:
            message.id,

          name:
            message.name,

          text:
            parsed.text,

          time:
            message.time,

          mine,

          replyToId:
            parsed.replyToId,

          replyTo:
            null,

          status:
            mine
              ? 'sent'
              : 'read'

        });


      } catch (error) {

        decryptFailed =
          true;

        console.error(
          'Message decryption failed:',
          error
        );


        decrypted.push({

          id:
            message.id,

          name:
            message.name,

          text:
            '[Unable to decrypt this message]',

          time:
            message.time,

          mine:
            message.name.toLowerCase() ===
            this.name.toLowerCase(),

          status:
            'sent'

        });

      }

    }


    // ==================================================
    // RESOLVE REPLIES AFTER ALL MESSAGES EXIST
    // ==================================================

    for (
      const message of decrypted
    ) {

      if (
        message.replyToId
      ) {

        message.replyTo =
          decrypted.find(
            original =>
              original.id ===
              message.replyToId
          ) || null;

      }

    }


    this.messages.set(
      decrypted
    );


    this.scrollSoon();


    // ==================================================
    // MARK RECEIVED HISTORY AS READ
    // ==================================================

    for (
      const message of decrypted
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


    // One-time migration: only create the shared bundle
    // if the current device successfully decrypted every
    // existing encrypted message.
    if (
      !decryptFailed &&
      !this.keyBundleExists
    ) {

      await this.createKeyBundleFromLegacyKey();

    }

  }


  // ==================================================
  // PARSE DECRYPTED MESSAGE
  //
  // New messages:
  // {
  //   text: "...",
  //   replyToId: "..."
  // }
  //
  // Also supports old E2E messages that
  // contained only plain text.
  // ==================================================

  private parseDecryptedMessage(
    value: string
  ): {
    text: string;
    replyToId: string | null;
  } {

    try {

      const parsed =
        JSON.parse(value);


      if (
        parsed &&
        typeof parsed.text ===
          'string'
      ) {

        return {

          text:
            parsed.text,

          replyToId:
            typeof parsed.replyToId ===
              'string'
              ? parsed.replyToId
              : null

        };

      }

    } catch {
      // Old encrypted message.
      // Treat it as normal text.
    }


    return {

      text:
        value,

      replyToId:
        null

    };

  }


  // ==================================================
  // E2E KEY PREPARATION
  // ==================================================

  private async prepareEncryptionKeys() {

    const savedPrivateKey =
      localStorage.getItem(
        this.privateKeyStorage
      );


    const savedPublicKey =
      localStorage.getItem(
        this.publicKeyStorage
      );


    // ==================================================
    // RESTORE EXISTING KEY PAIR
    // ==================================================

    if (
      savedPrivateKey &&
      savedPublicKey
    ) {

      const privateJwk =
        JSON.parse(
          savedPrivateKey
        );


      const publicJwk =
        JSON.parse(
          savedPublicKey
        );


      this.privateKey =
        await crypto.subtle.importKey(
          'jwk',
          privateJwk,
          {
            name:
              'ECDH',

            namedCurve:
              'P-256'
          },
          true,
          [
            'deriveKey'
          ]
        );


      this.publicKey =
        await crypto.subtle.importKey(
          'jwk',
          publicJwk,
          {
            name:
              'ECDH',

            namedCurve:
              'P-256'
          },
          true,
          []
        );


      return;

    }


    // ==================================================
    // GENERATE NEW KEY PAIR
    // ==================================================

    const keyPair =
      await crypto.subtle.generateKey(
        {
          name:
            'ECDH',

          namedCurve:
            'P-256'
        },

        true,

        [
          'deriveKey',
          'deriveBits'
        ]
      );


    this.privateKey =
      keyPair.privateKey;


    this.publicKey =
      keyPair.publicKey;


    const privateJwk =
      await crypto.subtle.exportKey(
        'jwk',
        keyPair.privateKey
      );


    const publicJwk =
      await crypto.subtle.exportKey(
        'jwk',
        keyPair.publicKey
      );


    localStorage.setItem(
      this.privateKeyStorage,
      JSON.stringify(
        privateJwk
      )
    );


    localStorage.setItem(
      this.publicKeyStorage,
      JSON.stringify(
        publicJwk
      )
    );

  }


  // ==================================================
  // SEND PUBLIC KEY
  // ==================================================

  private async sendPublicKey() {

    if (
      !this.socket ||
      !this.publicKey
    ) {
      return;
    }


    const jwk =
      await crypto.subtle.exportKey(
        'jwk',
        this.publicKey
      );


    this.socket.emit(
      'publicKey',
      {
        name:
          this.name,

        key:
          jwk
      }
    );

  }


  // ==================================================
  // DERIVE SHARED ENCRYPTION KEY
  // ==================================================

  private async deriveEncryptionKey() {

    if (
      !this.privateKey ||
      !this.peerPublicKey
    ) {

      throw new Error(
        'E2E keys are not available.'
      );

    }


    this.encryptionKey =
      await crypto.subtle.deriveKey(
        {
          name:
            'ECDH',

          public:
            this.peerPublicKey
        },

        this.privateKey,

        {
          name:
            'AES-GCM',

          length:
            256
        },

        true,

        [
          'encrypt',
          'decrypt'
        ]
      );

  }


  // ==================================================
  // USE LEGACY KEY / PROCESS PENDING DATA
  // ==================================================

  private async useLegacyKeyIfReady() {

    if (
      !this.keyBundleResolved ||
      this.keyBundleExists ||
      !this.encryptionKey
    ) {
      return;
    }

    this.masterKey =
      this.encryptionKey;

    this.encryptionReady.set(
      true
    );

    await this.processPendingData();

  }


  private async processPendingData() {

    if (!this.encryptionKey) {
      return;
    }

    if (this.pendingHistory) {

      const history =
        this.pendingHistory;

      this.pendingHistory =
        undefined;

      await this.processHistory(
        history
      );

    }

    if (
      this.pendingMessages.length
    ) {

      const pending =
        [
          ...this.pendingMessages
        ];

      this.pendingMessages =
        [];

      for (
        const message of pending
      ) {

        await this.processIncomingMessage(
          message
        );

      }

    }

  }


  // ==================================================
  // PASSWORD -> WRAPPING KEY
  //
  // Password remains inside the browser.
  // PBKDF2 is only used to protect the master key bundle.
  // ==================================================

  private async derivePasswordKey(
    salt: Uint8Array
  ): Promise<CryptoKey> {

    const passwordBytes =
      new TextEncoder().encode(
        this.passcode
      );

    const passwordKey =
      await crypto.subtle.importKey(
        'raw',
        passwordBytes,
        'PBKDF2',
        false,
        ['deriveKey']
      );

    return crypto.subtle.deriveKey(
      {
        name:
          'PBKDF2',

        salt,

        iterations:
          310000,

        hash:
          'SHA-256'
      },

      passwordKey,

      {
        name:
          'AES-GCM',

        length:
          256
      },

      false,

      [
        'encrypt',
        'decrypt'
      ]
    );

  }


  private async createKeyBundleFromLegacyKey() {

    if (
      this.keyBundleExists ||
      !this.encryptionKey ||
      !this.socket ||
      !this.passcode
    ) {
      return;
    }

    if (this.bundleCreationStarted) {
      return;
    }

    this.bundleCreationStarted =
      true;

    try {

      // First ask the server once more in case another
      // browser/device created the bundle meanwhile.
      this.socket.emit(
        'requestKeyBundle'
      );

      const masterRaw =
        await crypto.subtle.exportKey(
          'raw',
          this.encryptionKey
        );

      const salt =
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(
              this.roomId
            )
          )
        ).slice(0, 16);

      const wrappingKey =
        await this.derivePasswordKey(
          salt
        );

      const iv =
        crypto.getRandomValues(
          new Uint8Array(12)
        );

      const wrapped =
        await crypto.subtle.encrypt(
          {
            name:
              'AES-GCM',

            iv
          },

          wrappingKey,

          masterRaw
        );

      this.socket.emit(
        'saveKeyBundle',
        {
          ciphertext:
            this.arrayBufferToBase64(
              wrapped
            ),

          iv:
            this.arrayBufferToBase64(
              iv
            )
        }
      );

      // Do not assume that emit succeeded. The server
      // must confirm with keyBundleSaved.
      this.bundleMigrationAttempts++;

      this.bundleMigrationTimer =
        setTimeout(
          () => {

            if (
              !this.keyBundleExists
            ) {

              this.bundleCreationStarted =
                false;

              this.retryKeyBundleMigration();

            }

          },
          2000
        );

    } catch (error) {

      console.error(
        'Master key migration failed:',
        error
      );

      this.bundleCreationStarted =
        false;

      this.retryKeyBundleMigration();

    }

  }


  private retryKeyBundleMigration() {

    if (
      this.keyBundleExists ||
      !this.encryptionKey ||
      !this.socket ||
      !this.passcode
    ) {
      return;
    }

    if (
      this.bundleMigrationAttempts >= 5
    ) {
      console.error(
        'Unable to create the shared encryption key bundle after multiple attempts.'
      );
      return;
    }

    clearTimeout(
      this.bundleMigrationTimer
    );

    this.bundleMigrationTimer =
      setTimeout(
        () => {

          this.bundleMigrationTimer =
            undefined;

          this.createKeyBundleFromLegacyKey();

        },
        1000
      );

  }


  private async unwrapMasterKey(
    bundle: KeyBundleData
  ): Promise<CryptoKey> {

    const salt =
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(
            this.roomId
          )
        )
      ).slice(0, 16);

    const wrappingKey =
      await this.derivePasswordKey(
        salt
      );

    const iv =
      this.base64ToUint8Array(
        bundle.iv
      );

    const wrapped =
      this.base64ToUint8Array(
        bundle.ciphertext
      );

    const raw =
      await crypto.subtle.decrypt(
        {
          name:
            'AES-GCM',

          iv
        },

        wrappingKey,

        wrapped
      );

    return crypto.subtle.importKey(
      'raw',
      raw,
      {
        name:
          'AES-GCM'
      },
      true,
      [
        'encrypt',
        'decrypt'
      ]
    );

  }


  // ==================================================
  // ENCRYPT MESSAGE
  // ==================================================

  private async encryptMessage(
    text: string,
    replyToId:
      string | null
  ): Promise<{
    ciphertext: string;
    iv: string;
  }> {

    const key =
      this.masterKey ||
      this.encryptionKey;

    if (!key) {

      throw new Error(
        'Encryption key is not ready.'
      );

    }


    const iv =
      crypto.getRandomValues(
        new Uint8Array(12)
      );


    // ==================================================
    // Encrypt both text + reply reference.
    //
    // Server cannot read either.
    // ==================================================

    const payload = {

      text,

      replyToId

    };


    const encoded =
      new TextEncoder().encode(
        JSON.stringify(
          payload
        )
      );


    const encrypted =
      await crypto.subtle.encrypt(
        {
          name:
            'AES-GCM',

          iv
        },

        key,

        encoded
      );


    return {

      ciphertext:
        this.arrayBufferToBase64(
          encrypted
        ),

      iv:
        this.arrayBufferToBase64(
          iv
        )

    };

  }


  // ==================================================
  // DECRYPT MESSAGE
  // ==================================================

  private async decryptMessage(
    ciphertext: string,
    iv: string
  ): Promise<string> {

    const key =
      this.masterKey ||
      this.encryptionKey;

    if (!key) {

      throw new Error(
        'Encryption key is not ready.'
      );

    }


    const encrypted =
      this.base64ToUint8Array(
        ciphertext
      );


    const initializationVector =
      this.base64ToUint8Array(
        iv
      );


    const decrypted =
      await crypto.subtle.decrypt(
        {
          name:
            'AES-GCM',

          iv:
            initializationVector
        },

        key,

        encrypted
      );


    return new TextDecoder().decode(
      decrypted
    );

  }


  // ==================================================
  // BASE64 HELPERS
  // ==================================================

  private arrayBufferToBase64(
    buffer:
      ArrayBuffer |
      Uint8Array
  ): string {

    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(
            buffer
          );


    let binary = '';


    for (
      const byte of bytes
    ) {

      binary +=
        String.fromCharCode(
          byte
        );

    }


    return btoa(
      binary
    );

  }


  private base64ToUint8Array(
    value: string
  ): Uint8Array {

    const binary =
      atob(value);


    const bytes =
      new Uint8Array(
        binary.length
      );


    for (
      let i = 0;
      i < binary.length;
      i++
    ) {

      bytes[i] =
        binary.charCodeAt(i);

    }


    return bytes;

  }


  // ==================================================
  // SEND MESSAGE
  // ==================================================

  async send() {

    const text =
      this.draft.trim();


    if (
      !text ||
      !this.socket ||
      !this.online() ||
      !this.encryptionReady()
    ) {
      return;
    }


    try {

      if (
        !this.encryptionKey
      ) {

        this.encryptionReady.set(
          false
        );


        this.socket.emit(
          'requestPeerKey'
        );


        return;

      }


      // ==================================================
      // REPLY ID
      // ==================================================

      const reply =
        this.replyingTo();


      const replyToId =
        reply?.id ||
        null;


      // ==================================================
      // ENCRYPT
      // ==================================================

      const encrypted =
        await this.encryptMessage(
          text,
          replyToId
        );


      // ==================================================
      // SEND TO SERVER
      // ==================================================

      this.socket.emit(
        'message',
        encrypted
      );


      this.socket.emit(
        'stopTyping'
      );


      // ==================================================
      // CLEAR INPUT / REPLY
      // ==================================================

      this.draft = '';

      this.replyingTo.set(
        null
      );


    } catch (error) {

      console.error(
        'Encryption failed:',
        error
      );

    }

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

    clearTimeout(
      this.bundleMigrationTimer
    );

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