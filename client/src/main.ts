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
            [(ngModel)]="name"
            name="name"
            maxlength="24"
            placeholder="Your name"
            autocomplete="off"
            autofocus
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

          @for (
            item of messages();
            track item.id || $index
          ) {

            @if (item.name === '__system') {

              <div class="system">
                {{ item.text }}
              </div>

            } @else {

              @if (shouldShowDate(item, $index)) {

                <div class="date-pill">
                  {{ formatDateLabel(item.time) }}
                </div>

              }


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

                    <span *ngIf="item.mine">
                      ✓✓
                    </span>
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

  // ==================================================
  // FIXED PRIVATE ROOM
  // ==================================================

  private readonly roomId =
    'our-private-chat-9x7m2k8p';


  joined = signal(false);

  online = signal(false);

  typing = signal('');

  messages = signal<ChatMessage[]>([]);

  name = '';

  draft = '';

  private socket?: Socket;

  private typingTimer?: ReturnType<typeof setTimeout>;


  // ==================================================
  // JOIN CHAT
  // ==================================================

  join() {

    this.name = this.name
      .trim()
      .slice(0, 24);

    if (!this.name) {
      return;
    }

    this.joined.set(true);

    this.socket = io();


    // ==================================================
    // CONNECT
    // ==================================================

    this.socket.on('connect', () => {

      this.online.set(true);

      this.socket?.emit('join', {
        roomId: this.roomId,
        name: this.name
      });

    });


    // ==================================================
    // DISCONNECT
    // ==================================================

    this.socket.on('disconnect', () => {

      this.online.set(false);

    });


    // ==================================================
    // DATABASE CHAT HISTORY
    // ==================================================

    this.socket.on(
      'history',
      (history: ChatMessage[]) => {

        this.messages.set(
          history.map(message => ({
            ...message,
            mine:
              message.name === this.name
          }))
        );

        this.scrollSoon();

      }
    );


    // ==================================================
    // NEW MESSAGE
    // ==================================================

    this.socket.on(
      'message',
      (message: ChatMessage) => {

        this.messages.update(list => [
          ...list,
          {
            ...message,
            mine:
              message.name === this.name
          }
        ]);

        this.scrollSoon();

      }
    );


    // ==================================================
    // SYSTEM MESSAGE
    // ==================================================

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


    // ==================================================
    // TYPING
    // ==================================================

    this.socket.on(
      'typing',
      (who: string) => {

        if (who === this.name) {
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

      }
    );

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

    this.socket.emit(
      'message',
      text
    );

    this.socket.emit(
      'stopTyping'
    );

    this.draft = '';

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
  // DATE SEPARATOR
  // ==================================================

  shouldShowDate(
    item: ChatMessage,
    index: number
  ): boolean {

    if (!item.time) {
      return false;
    }

    // First message
    if (index === 0) {
      return true;
    }

    // Find previous actual chat message
    // and compare calendar dates.
    for (
      let i = index - 1;
      i >= 0;
      i--
    ) {

      const previous =
        this.messages()[i];

      if (
        previous.name === '__system' ||
        !previous.time
      ) {
        continue;
      }

      return !this.isSameDay(
        previous.time,
        item.time
      );

    }

    return true;

  }


  // ==================================================
  // CHECK SAME DAY
  // ==================================================

  private isSameDay(
    firstTime: string,
    secondTime: string
  ): boolean {

    const first =
      new Date(firstTime);

    const second =
      new Date(secondTime);

    if (
      isNaN(first.getTime()) ||
      isNaN(second.getTime())
    ) {
      return false;
    }

    return (
      first.getFullYear() ===
        second.getFullYear() &&

      first.getMonth() ===
        second.getMonth() &&

      first.getDate() ===
        second.getDate()
    );

  }


  // ==================================================
  // WHATSAPP STYLE DATE LABEL
  // ==================================================

  formatDateLabel(
    time: string
  ): string {

    const date =
      new Date(time);

    if (
      isNaN(
        date.getTime()
      )
    ) {
      return '';
    }


    const now =
      new Date();


    // Today
    if (
      this.isSameDay(
        time,
        now.toISOString()
      )
    ) {
      return 'Today';
    }


    // Yesterday
    const yesterday =
      new Date(now);

    yesterday.setDate(
      yesterday.getDate() - 1
    );


    if (
      this.isSameDay(
        time,
        yesterday.toISOString()
      )
    ) {
      return 'Yesterday';
    }


    // Older dates
    return date.toLocaleDateString(
      'en-IN',
      {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }
    );

  }


  // ==================================================
  // AUTO SCROLL
  // ==================================================

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