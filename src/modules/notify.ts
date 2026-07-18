let notifyID: string | null = null;

export function registerNotify(types: _ZoteroTypes.Notifier.Type[]): void {
  if (notifyID) return;
  const callback = {
    notify: async (...data: Parameters<_ZoteroTypes.Notifier.Notify>) => {
      if (!addon?.data.alive) {
        unregisterNotify();
        return;
      }
      await addon.hooks.onNotify(...data);
    },
  };
  notifyID = Zotero.Notifier.registerObserver(callback, types);
}

export function unregisterNotify(): void {
  if (!notifyID) return;
  Zotero.Notifier.unregisterObserver(notifyID);
  notifyID = null;
}
