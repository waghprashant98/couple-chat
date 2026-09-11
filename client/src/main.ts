import { bootstrapApplication } from '@angular/platform-browser';
import { Component, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { io, Socket } from 'socket.io-client';

interface ChatMessage {
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
        <p class="sub">A simple place for our messages.</p>
        <form (ngSubmit)="join()">
          <input [(ngModel)]="name" name="name" maxlength="24"
                 placeholder="Your name" autocomplete="off" autofocus required>
          <button type="submit">Enter chat <span>→</span></button>
        </form>
      </section>
    } @else {
      <section class="chat glass">
        <header>
          <div class="avatar">♥</div>
          <div class="head-text">
            <h2>Our Chat</h2>
            <span [class.offline]="!online()">
              <i></i>{{ online() ? (typing() || 'Online') : 'Connecting…' }}
            </span>
          </div>
          <div class="dots">•••</div>
        </header>

        <main class="messages" #messageBox>
          <div class="date-pill">Today</div>
          @for (item of messages(); track $index) {
            @if (item.name === '__system') {
              <div class="system">{{ item.text }}</div>
            } @else {
              <div class="row" [class.mine]="item.mine">
                <div class="bubble">
                  @if (!item.mine) { <small>{{ item.name }}</small> }
                  <div>{{ item.text }}</div>
                  <time>{{ item.time }} <span *ngIf="item.mine">✓✓</span></time>
                </div>
              </div>
            }
          }
        </main>

        <form class="composer" (ngSubmit)="send()">
          <input [(ngModel)]="draft" name="draft" maxlength="1000"
                 placeholder="Write something…" autocomplete="off"
                 (input)="handleTyping()">
          <button type="submit" [disabled]="!draft.trim()" aria-label="Send">↑</button>
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
  name = '';
  draft = '';
  private socket?: Socket;
  private typingTimer?: ReturnType<typeof setTimeout>;

  join() {
    this.name = this.name.trim().slice(0, 24);
    if (!this.name) return;
    this.joined.set(true);

    this.socket = io();
    this.socket.on('connect', () => {
      this.online.set(true);
      this.socket?.emit('join', this.name);
    });
    this.socket.on('disconnect', () => this.online.set(false));
    this.socket.on('message', (m: Omit<ChatMessage, 'mine'>) => {
      this.messages.update(list => [...list, {...m, mine: m.name === this.name}]);
      this.scrollSoon();
    });
    this.socket.on('system', (text: string) => {
      this.messages.update(list => [...list, {name: '__system', text, time: ''}]);
      this.scrollSoon();
    });
    this.socket.on('typing', (who: string) => {
      this.typing.set(`${who} is typing…`);
      clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => this.typing.set(''), 1400);
    });
    this.socket.on('stopTyping', () => this.typing.set(''));
  }

  send() {
    const text = this.draft.trim();
    if (!text || !this.socket) return;
    this.socket.emit('message', text);
    this.socket.emit('stopTyping');
    this.draft = '';
  }

  handleTyping() {
    if (!this.socket) return;
    this.socket.emit('typing');
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.socket?.emit('stopTyping'), 900);
  }

  private scrollSoon() {
    setTimeout(() => {
      const el = document.querySelector('.messages') as HTMLElement | null;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  ngOnDestroy() {
    clearTimeout(this.typingTimer);
    this.socket?.disconnect();
  }
}

bootstrapApplication(AppComponent).catch(console.error);