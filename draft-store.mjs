export class DraftStore {
  async open() {
    if (this.connection) return this.connection;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('yin-jian-projects', 1);
      let expired = false;
      const timeout = setTimeout(() => {
        expired = true;
        reject(Error('本機保存未回應，請先下載專案檔備份。'));
      }, 3000);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('documents', { keyPath: 'id' });
        db.createObjectStore('summaries', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      };
      request.onerror = () => {
        clearTimeout(timeout);
        reject(request.error);
      };
      request.onblocked = () => {
        clearTimeout(timeout);
        expired = true;
        reject(Error('請關閉其他音剪分頁後重試保存。'));
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        if (expired) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.connection = null;
        };
        this.connection = db;
        resolve(db);
      };
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }
  async transaction(stores, mode, operate) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = operate(tx);
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result?.result);
      tx.onabort = tx.onerror = () => reject(tx.error || Error('無法保存剪輯，請下載專案檔備份。'));
    });
  }
  save(id, project) {
    return this.transaction(['documents', 'summaries'], 'readwrite', (tx) => {
      const updatedAt = Date.now();
      tx.objectStore('documents').put({ id, project });
      tx.objectStore('summaries').put({
        id,
        updatedAt,
        name: project.source.name,
        source: project.source.kind,
        length: project.audio.length,
      });
    });
  }
  get(id) {
    return this.transaction(['documents'], 'readonly', (tx) => tx.objectStore('documents').get(id));
  }
  remove(id) {
    return this.transaction(['documents', 'summaries'], 'readwrite', (tx) => {
      tx.objectStore('documents').delete(id);
      tx.objectStore('summaries').delete(id);
    });
  }
  list(limit = 10) {
    return this.transaction(['summaries'], 'readonly', (tx) => {
      const items = [],
        request = tx.objectStore('summaries').index('updatedAt').openCursor(null, 'prev');
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && items.length < limit) {
          items.push(cursor.value);
          cursor.continue();
        }
      };
      return () => items;
    });
  }
}
