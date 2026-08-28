/**
 * Dependency-free ANSI spinner. Writes frames to stderr with `\r` + erase
 * so stdout stays clean for streamed text. No-op when the stream is not a
 * TTY (piped output must not get spinner noise).
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;

  constructor(
    private readonly text: string,
    private readonly out: NodeJS.WriteStream = process.stderr,
  ) {}

  start(): void {
    if (this.active || !this.out.isTTY) return;
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.out.write("\r\x1b[K");
  }

  private render(): void {
    this.out.write(`\r${FRAMES[this.frame % FRAMES.length]} ${this.text}`);
    this.frame += 1;
  }
}
