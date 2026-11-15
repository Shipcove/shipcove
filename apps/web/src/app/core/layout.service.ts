import { Injectable, signal } from '@angular/core';

/** Bureau : barre latérale fixe (sinon tiroir). */
const DESKTOP = '(min-width: 1024px)';
/** Large : volet de droite à côté de la conversation (sinon par-dessus, en plein écran). */
const WIDE = '(min-width: 1280px)';
const COLLAPSED_KEY = 'cap.sidebar.collapsed';

/** Mise en page adaptative : points de rupture, tiroir de navigation, barre latérale repliée. */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly desktop = signal(match(DESKTOP));
  readonly wide = signal(match(WIDE));
  /** Tiroir de navigation ouvert (mobile et tablette). */
  readonly drawerOpen = signal(false);
  /** Barre latérale repliée (bureau). */
  readonly collapsed = signal(read(COLLAPSED_KEY) === '1');

  constructor() {
    listen(DESKTOP, (v) => {
      this.desktop.set(v);
      if (v) this.drawerOpen.set(false);
    });
    listen(WIDE, (v) => this.wide.set(v));
  }

  /** Bouton de navigation : tiroir sur petit écran, repli sur bureau. */
  toggleNav(): void {
    if (this.desktop()) this.setCollapsed(!this.collapsed());
    else this.drawerOpen.update((v) => !v);
  }

  setCollapsed(v: boolean): void {
    this.collapsed.set(v);
    try {
      localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
    } catch {
      /* préférence non conservée */
    }
  }
}

function match(q: string): boolean {
  return typeof matchMedia === 'function' ? matchMedia(q).matches : true;
}

function listen(q: string, fn: (v: boolean) => void): void {
  if (typeof matchMedia !== 'function') return;
  matchMedia(q).addEventListener('change', (e) => fn(e.matches));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
