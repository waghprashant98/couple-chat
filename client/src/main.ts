import { bootstrapApplication } from '@angular/platform-browser';
import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';

interface ChatMessage {
  id?: string;
  name: string;
  text: string;
  time: string;
  mine?: boolean;
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
            [(ngModel)]="roomId"
            name="roomId"
            maxlength="100"
            placeholder="Room code"
            autocomplete="off"
            required
          >

          <input
            [(ngModel)]="name"
            name="name"
            maxlength="24"
            placeholder="Your name"
            autocomplete="off"
            required
          >

          <button type="submit">
            Enter chat <span>→</span>
          </button>

        </form>

      </section>

    } @else {

      <section class="chat glass">

        <header>

          <div class="avatar">♥</div>

          <div class="head-text">

            <h2>Our Chat</h2>

            <span [class.offline]="!online()">
              <i></i>
              {{ online() ? (typing() || 'Online') : 'Connecting…' }}
            </span>

          </div>

          <div class="dots">•••</div>

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
                    {{ item.time }}
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

  styles: [``]
})
export class AppComponent implements OnDestroy {

  joined = signal(false);

  online = signal(false);

  typing = signal('');

  messages = signal<ChatMessage[]>([]);

  roomId = '';

  name = '';

  draft = '';

  private socket?: Socket;

  private typingTimer?: ReturnType<typeof setTimeout>;


  join() {

    this.roomId = this.roomId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 100);

    this.name = this.name
      .trim()
      .slice(0, 24);

    if (!this.roomId || !this.name) {
      return;
    }

    this.joined.set(true);

    this.socket = io();


    // Connected
    this.socket.on('connect', () => {

      this.online.set(true);

      // IMPORTANT:
      // Server expects roomId + name
      this.socket?.emit('join', {
        roomId: this.roomId,
        name: this.name
      });

    });


    // Connection closed
    this.socket.on('disconnect', () => {

      this.online.set(false);

    });


    // Database history
    this.socket.on(
      'history',
      (history: ChatMessage[]) => {

        this.messages.set(
          history.map(message => ({
            ...message,
            mine: message.name === this.name
          }))
        );

        this.scrollSoon();

      }
    );


    // New message
    this.socket.on(
      'message',
      (message: ChatMessage) => {

        this.messages.update(list => [
          ...list,
          {
            ...message,
            mine: message.name === this.name
          }
        ]);

        this.scrollSoon();

      }
    );


    // System message
    this.socket.on(
      'system',
      (text: string) => {

        this.messages.update(list => [
          ...list,
          {
            name: '__system',
            text,
            time: ''
          }
        ]);

        this.scrollSoon();

      }
    );


    // Typing
    this.socket.on(
      'typing',
      (who: string) => {

        if (who === this.name) {
          return;
        }

        this.typing.set(
          `${who} is typing…`
        );

        clearTimeout(this.typingTimer);

        this.typingTimer = setTimeout(
          () => this.typing.set(''),
          1400
        );

      }
    );


    this.socket.on(
      'stopTyping',
      () => {

        this.typing.set('');

      }
    );


    // Join error
    this.socket.on(
      'joinError',
      (error: string) => {

        console.error('Join error:', error);

        this.joined.set(false);

      }
    );

  }


  send() {

    const text = this.draft.trim();

    if (
      !text ||
      !this.socket ||
      !this.online()
    ) {
      return;
    }

    this.socket.emit(
      'message',
      text
    );

    this.socket.emit(
      'stopTyping'
    );

    this.draft = '';

  }


  handleTyping() {

    if (
      !this.socket ||
      !this.online()
    ) {
      return;
    }

    this.socket.emit('typing');

    clearTimeout(this.typingTimer);

    this.typingTimer = setTimeout(
      () => {
        this.socket?.emit('stopTyping');
      },
      900
    );

  }


  private scrollSoon() {

    setTimeout(() => {

      const el =
        document.querySelector(
          '.messages'
        ) as HTMLElement | null;

      if (el) {
        el.scrollTop =
          el.scrollHeight;
      }

    });

  }


  ngOnDestroy() {

    clearTimeout(
      this.typingTimer
    );

    this.socket?.disconnect();

  }

}


bootstrapApplication(
  AppComponent
).catch(console.error);