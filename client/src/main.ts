import { bootstrapApplication } from '@angular/platform-browser';
import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';

interface EncryptedMessage {
  id?: string;
  name: string;
  ciphertext: string;
  iv: string;
  time: string;
  mine?: boolean;
}

interface ChatMessage {
  id?: string;
  name: string;
  text: string;
  time: string;
  mine?: boolean;
}

interface PublicKeyData {
  name: string;
  key: JsonWebKey;
}

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
          A simple place for our messages.
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

        <header>

          <div class="avatar">♥</div>

          <div class="head-text">

            <h2>My Love</h2>

            <span [class.offline]="!online()">
              <i></i>
              {{ online() ? (typing() || 'Online') : 'Connecting…' }}
            </span>

          </div>

        </header>


        <main class="messages" #messageBox>

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
              >

                <div class="bubble">

                  @if (!item.mine) {
                    <small>{{ item.name }}</small>
                  }

                  <div>
                    {{ item.text }}
                  </div>

                  <time>
                    {{ formatTime(item.time) }}
                    <span *ngIf="item.mine">✓✓</span>
                  </time>

                </div>

              </div>

            }

          }

        </main>


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
    .login-error {
      margin: 14px 0 0;
      color: #c05270;
      font-size: 12px;
      font-weight: 600;
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

  typing = signal('');

  loginError = signal('');

  encryptionReady = signal(false);

  messages = signal<ChatMessage[]>([]);

  name = '';

  passcode = '';

  draft = '';


  // ==================================================
  // SOCKET / TIMERS
  // ==================================================

  private socket?: Socket;

  private typingTimer?: ReturnType<typeof setTimeout>;


  // ==================================================
  // E2E KEYS
  // ==================================================

  private privateKey?: CryptoKey;

  private publicKey?: CryptoKey;

  private peerPublicKey?: CryptoKey;

  private encryptionKey?: CryptoKey;


  // ==================================================
  // PENDING HISTORY
  //
  // History can arrive before the peer key.
  // Keep it temporarily until encryption is ready.
  // ==================================================

  private pendingHistory?: EncryptedMessage[];


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
    // CREATE / RESTORE E2E KEY PAIR
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

    this.socket = io();


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
            roomId: this.roomId,
            name: this.name,
            passcode: this.passcode
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

        this.encryptionKey = undefined;

        this.peerPublicKey = undefined;

        this.pendingHistory = undefined;

      }
    );


    // ==================================================
    // PEER PUBLIC KEY
    // ==================================================

    this.socket.on(
      'peerPublicKey',
      async (data: PublicKeyData) => {

        try {

          if (
            !data ||
            !data.key
          ) {
            return;
          }


          // Do not use our own key
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
                name: 'ECDH',
                namedCurve: 'P-256'
              },
              true,
              []
            );


          await this.deriveEncryptionKey();

          this.encryptionReady.set(true);


          // ==================================================
          // PROCESS HISTORY THAT ARRIVED BEFORE KEY
          // ==================================================

          if (this.pendingHistory) {

            const history =
              this.pendingHistory;

            this.pendingHistory =
              undefined;

            await this.processHistory(
              history
            );

          }


          // Ask server to send the peer key
          // back if this client connected later.
          this.socket?.emit(
            'requestPeerKey'
          );


        } catch (error) {

          console.error(
            'Peer key error:',
            error
          );

          this.encryptionReady.set(false);

        }

      }
    );


    // ==================================================
    // PEER REQUESTED OUR PUBLIC KEY
    // ==================================================

    this.socket.on(
      'requestPublicKey',
      () => {

        this.sendPublicKey();

      }
    );


    // ==================================================
    // DATABASE CHAT HISTORY
    // ==================================================

    this.socket.on(
      'history',
      async (history: EncryptedMessage[]) => {

        // ==================================================
        // KEY NOT READY YET
        //
        // Do NOT lose history.
        // Store it temporarily and decrypt it once
        // the peer public key is available.
        // ==================================================

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
      async (message: EncryptedMessage) => {

        try {

          // If key is not ready, ignore the message.
          // Normally this cannot happen because send
          // button remains disabled until encryptionReady.
          if (!this.encryptionKey) {
            return;
          }


          const text =
            await this.decryptMessage(
              message.ciphertext,
              message.iv
            );


          this.messages.update(
            list => [
              ...list,

              {
                id: message.id,

                name: message.name,

                text,

                time: message.time,

                mine:
                  message.name.toLowerCase() ===
                  this.name.toLowerCase()
              }
            ]
          );


          this.scrollSoon();


        } catch (error) {

          console.error(
            'Incoming message decryption failed:',
            error
          );

        }

      }
    );


    // ==================================================
    // SYSTEM MESSAGE
    // ==================================================

    this.socket.on(
      'system',
      (text: string) => {

        this.messages.update(
          list => [
            ...list,

            {
              name: '__system',
              text,
              time: ''
            }
          ]
        );

        this.scrollSoon();

      }
    );


    // ==================================================
    // TYPING
    // ==================================================

    this.socket.on(
      'typing',
      (who: string) => {

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
            () => this.typing.set(''),
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
      (error: string) => {

        console.error(
          'Join error:',
          error
        );


        this.joined.set(false);

        this.online.set(false);

        this.encryptionReady.set(false);

        this.encryptionKey = undefined;

        this.peerPublicKey = undefined;

        this.pendingHistory = undefined;


        this.loginError.set(
          error ||
          'Unable to enter the chat.'
        );


        this.socket?.disconnect();

      }
    );

  }


  // ==================================================
  // PROCESS / DECRYPT HISTORY
  // ==================================================

  private async processHistory(
    history: EncryptedMessage[]
  ) {

    if (!this.encryptionKey) {
      return;
    }


    const decrypted: ChatMessage[] = [];


    for (
      const message of history
    ) {

      try {

        const text =
          await this.decryptMessage(
            message.ciphertext,
            message.iv
          );


        decrypted.push({
          id: message.id,

          name: message.name,

          text,

          time: message.time,

          mine:
            message.name.toLowerCase() ===
            this.name.toLowerCase()
        });


      } catch (error) {

        console.error(
          'Message decryption failed:',
          error
        );


        decrypted.push({
          id: message.id,

          name: message.name,

          text: '[Unable to decrypt this message]',

          time: message.time,

          mine:
            message.name.toLowerCase() ===
            this.name.toLowerCase()
        });

      }

    }


    this.messages.set(
      decrypted
    );

    this.scrollSoon();

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


    // --------------------------------------------------
    // Restore existing key pair
    // --------------------------------------------------

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
            name: 'ECDH',
            namedCurve: 'P-256'
          },
          true,
          ['deriveKey']
        );


      this.publicKey =
        await crypto.subtle.importKey(
          'jwk',
          publicJwk,
          {
            name: 'ECDH',
            namedCurve: 'P-256'
          },
          true,
          []
        );


      return;
    }


    // --------------------------------------------------
    // Generate new key pair
    // --------------------------------------------------

    const keyPair =
      await crypto.subtle.generateKey(
        {
          name: 'ECDH',
          namedCurve: 'P-256'
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
      JSON.stringify(privateJwk)
    );


    localStorage.setItem(
      this.publicKeyStorage,
      JSON.stringify(publicJwk)
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
        name: this.name,
        key: jwk
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
      return;
    }


    this.encryptionKey =
      await crypto.subtle.deriveKey(
        {
          name: 'ECDH',
          public: this.peerPublicKey
        },
        this.privateKey,
        {
          name: 'AES-GCM',
          length: 256
        },
        false,
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
    text: string
  ): Promise<{
    ciphertext: string;
    iv: string;
  }> {

    if (
      !this.encryptionKey
    ) {
      throw new Error(
        'Encryption key is not ready.'
      );
    }


    const iv =
      crypto.getRandomValues(
        new Uint8Array(12)
      );


    const encoded =
      new TextEncoder().encode(
        text
      );


    const encrypted =
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv
        },
        this.encryptionKey,
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

    if (
      !this.encryptionKey
    ) {
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
          name: 'AES-GCM',
          iv: initializationVector
        },
        this.encryptionKey,
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
    buffer: ArrayBuffer | Uint8Array
  ): string {

    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer);


    let binary = '';


    for (
      const byte of bytes
    ) {
      binary += String.fromCharCode(
        byte
      );
    }


    return btoa(binary);

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

      const encrypted =
        await this.encryptMessage(
          text
        );


      this.socket.emit(
        'message',
        encrypted
      );


      this.socket.emit(
        'stopTyping'
      );


      this.draft = '';


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
  // WHATSAPP STYLE TIME
  // ==================================================

  formatTime(
    time: string
  ): string {

    if (!time) {
      return '';
    }


    const date =
      new Date(time);


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
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
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
          ) as HTMLElement | null;


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

    this.socket?.disconnect();

  }

}


// ==================================================
// BOOTSTRAP
// ==================================================

bootstrapApplication(
  AppComponent
).catch(console.error);