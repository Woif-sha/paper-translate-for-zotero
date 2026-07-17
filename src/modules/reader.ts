import { config } from "../../package.json";

export function registerReaderInitializer() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    (event) => {
      addon.data.translate.selectedText = event.params.annotation.text.trim();
      addon.hooks.onReaderPopupShow(event);
    },
    config.addonID,
  );
}
