import { DraftStore } from './draft-store.mjs';
import { validateProject, parseProject, PROJECT_LIMIT } from './project.mjs';
import { recordIssue } from './support.mjs';

const $ = (id) => document.getElementById(id);
export class ProjectSession {
  constructor({ snapshot, restore, notify }) {
    this.snapshot = snapshot;
    this.restore = restore;
    this.notify = notify;
    this.store = new DraftStore();
    this.queue = Promise.resolve();
    this.revision = 0;
    this.limit = 10;
    $('more-drafts').addEventListener('click', () => {
      this.limit += 10;
      this.refresh();
    });
    $('show-drafts').addEventListener('click', () => {
      const panel = $('draft-panel');
      panel.hidden = false;
      panel.open = true;
      panel.scrollIntoView({ block: 'start' });
      panel.querySelector('summary').focus({ preventScroll: true });
    });
    $('save-project').addEventListener('click', () => this.download());
    $('open-project').addEventListener('click', () => $('project-input').click());
    $('project-input').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        if (file.size > PROJECT_LIMIT) throw Error('專案檔過大，請選擇 8 MB 以內的音剪專案。');
        await this.restore(parseProject(await file.text()));
      } catch (error) {
        this.notify(error.message, true, 'project-import');
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.flush();
    });
    window.addEventListener('pagehide', () => this.flush());
    window.addEventListener('focus', () => this.refresh());
    this.refresh();
  }
  activate(source, id = crypto.randomUUID()) {
    this.source = source;
    this.id = id;
    this.revision++;
    this.schedule();
  }
  suspend() {
    clearTimeout(this.timer);
    this.source = null;
    this.revision++;
  }
  status(message, error = false) {
    if (error) recordIssue('project-save');
    $('project-status').textContent = message;
    $('project-status').classList.toggle('save-error', error);
  }
  schedule() {
    if (!this.source) return;
    this.revision++;
    this.status('正在保存剪輯進度…');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  project() {
    const value = this.snapshot();
    return value && this.source
      ? validateProject({ app: 'yin-jian', version: 1, source: this.source, ...value })
      : null;
  }
  flush() {
    clearTimeout(this.timer);
    let project;
    try {
      project = this.project();
    } catch {
      this.status('尚未保存，請先完成目前的段落調整再儲存專案。', true);
      return this.queue;
    }
    if (!project) return this.queue;
    const id = this.id,
      revision = this.revision;
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        try {
          await this.store.save(id, project);
          if (id === this.id && revision === this.revision)
            this.status(
              `已自動保存 ${new Date().toLocaleTimeString('zh-TW', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })}`,
            );
          await this.refresh();
        } catch {
          if (id === this.id) this.status('本機保存失敗，請按「儲存專案檔」備份；目前剪輯仍可使用。', true);
        }
      });
    return this.queue;
  }
  async refresh() {
    try {
      const summaries = await this.store.list(this.limit);
      const list = $('draft-list');
      list.replaceChildren();
      $('draft-panel').hidden = !summaries.length;
      $('show-drafts').disabled = !summaries.length;
      $('more-drafts').hidden = summaries.length < this.limit;
      for (const item of summaries) {
        const row = document.createElement('li'),
          details = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = item.name;
        const time = document.createElement('small');
        time.textContent = new Date(item.updatedAt).toLocaleString('zh-TW');
        details.append(name, time);
        const restore = document.createElement('button');
        restore.className = 'button small subtle';
        restore.textContent = '繼續剪輯';
        restore.addEventListener('click', async () => {
          try {
            const record = await this.store.get(item.id);
            if (!record) throw Error('這份備份已不存在，請選擇其他備份或開啟專案檔。');
            await this.restore(validateProject(record.project));
          } catch (error) {
            this.notify(error.message, true);
          }
        });
        const remove = document.createElement('button');
        remove.className = 'text-button';
        remove.textContent = '移除備份';
        remove.setAttribute('aria-label', `移除 ${item.name} 的備份`);
        remove.addEventListener('click', async () => {
          try {
            await this.store.remove(item.id);
            if (item.id === this.id) this.status('已移除備份；下次修改時會重新保存。');
            await this.refresh();
          } catch {
            this.notify('無法移除備份，請稍後重試。', true);
          }
        });
        row.append(details, restore, remove);
        list.append(row);
      }
    } catch {
      this.status('瀏覽器無法自動保存，請使用專案檔備份。', true);
    }
  }
  download() {
    try {
      const project = this.project();
      if (!project) return;
      const text = JSON.stringify(project);
      if (new TextEncoder().encode(text).length > PROJECT_LIMIT) throw Error('專案紀錄過大，請先匯出音檔並保留原檔。');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${project.preferences.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '我的剪輯'}.yin-jian.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notify('專案檔已下載，包含剪輯與復原紀錄；請一併保留原始音檔。');
    } catch (error) {
      this.notify(error.message, true);
    }
  }
}
