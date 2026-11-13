import { Injectable, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>((localStorage.getItem('cap.theme') as ThemeMode) ?? 'system');
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    this.apply();
    this.media.addEventListener('change', () => this.apply());
  }

  set(mode: ThemeMode): void {
    this.mode.set(mode);
    localStorage.setItem('cap.theme', mode);
    this.apply();
  }

  isDark(): boolean {
    return this.mode() === 'dark' || (this.mode() === 'system' && this.media.matches);
  }

  private apply(): void {
    document.documentElement.classList.toggle('dark', this.isDark());
  }
}
