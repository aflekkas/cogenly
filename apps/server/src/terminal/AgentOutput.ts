/** Bounded head/tail output with absolute UTF-16 offsets, even after the middle is dropped. */
export class AgentOutput {
  private head = "";
  private tail = "";
  private length = 0;

  append(data: string): void {
    this.head = (this.head + data).slice(0, 8_000);
    this.tail = (this.tail + data).slice(-24_000);
    this.length += data.length;
  }

  read(sinceOffset = 0) {
    const start = Math.min(Math.max(0, sinceOffset), this.length);
    const tailStart = Math.max(this.head.length, this.length - this.tail.length);
    const head = this.head.slice(start);
    const tail = this.tail.slice(
      Math.max(0, Math.max(start, tailStart) - (this.length - this.tail.length)),
    );
    const omitted = Math.max(0, tailStart - Math.max(start, this.head.length));
    return {
      output: head + (omitted > 0 ? `\n[... ${omitted} characters omitted ...]\n` : "") + tail,
      nextOffset: this.length,
      truncated: omitted > 0,
    };
  }
}
