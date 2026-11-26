// One transfer at a time. Apply to RAM promptly; persist only after editing settles.
export class AutoSave {
  constructor({
    apply,
    save,
    changed = () => {},
    error = () => {},
    delay = 200,
    idle = 1500,
  }) {
    Object.assign(this, { apply, save, changed, error, delay, idle });
    this.revision = this.applied = this.saved = 0;
    this.enabled = this.busy = false;
    this.timer = null;
  }
  get pending() {
    return this.revision !== this.saved;
  }
  edit() {
    this.revision++;
    this.lastEdit = Date.now();
    this.schedule(this.delay);
    this.changed();
  }
  start() {
    this.enabled = true;
    this.applied = this.saved; // A reconnect must reapply any unsaved changes.
    this.schedule(this.delay);
  }
  stop() {
    this.enabled = false;
    clearTimeout(this.timer);
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (this.enabled && this.pending && !this.busy)
      this.timer = setTimeout(() => this.flush(), delay);
  }
  async flush() {
    if (!this.enabled || this.busy || !this.pending) return;
    const revision = this.revision;
    const persist = this.applied === revision;
    const remaining = this.idle - (Date.now() - this.lastEdit);
    if (persist && remaining > 0) {
      this.schedule(remaining);
      return;
    }
    this.busy = true;
    this.changed();
    try {
      if (persist) {
        await this.save();
        this.saved = revision;
      } else {
        await this.apply();
        this.applied = revision;
      }
    } catch (e) {
      this.stop(); // Keep unsaved edits, but never loop on a failing flash write.
      this.error(e);
    } finally {
      this.busy = false;
      this.changed();
      this.schedule(this.delay);
    }
  }
}
