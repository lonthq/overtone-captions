/** Short on-player label after a mode change ("Captions: styled"). CSS: .ot-toast / .ot-toast-visible. */
export class Toast {
  readonly el: HTMLDivElement;
  private readonly durationMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement, durationMs = 1500) {
    this.durationMs = durationMs;
    this.el = document.createElement('div');
    this.el.className = 'ot-toast';
    this.el.setAttribute('role', 'status');
    parent.append(this.el);
  }

  show(text: string): void {
    this.el.textContent = text;
    this.el.classList.add('ot-toast-visible');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.classList.remove('ot-toast-visible');
      this.el.textContent = '';
    }, this.durationMs);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.el.remove();
  }
}
