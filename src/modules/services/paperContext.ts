import { translateWithPaperContext } from "../../backends/translator";
import { TranslateService } from "./base";

export const PaperContextTranslation: TranslateService = {
  id: "paper-context",
  name: "Paper Context Translation",
  type: "sentence",
  async translate(data) {
    if (!data.itemId)
      throw new Error("Translation task has no Reader attachment ID");
    const refresh = addon.api.getTemporaryRefreshHandler({ task: data });
    data.result = "";
    data.result = await translateWithPaperContext({
      attachmentItemID: data.itemId,
      sourceLanguage: data.langfrom,
      targetLanguage: data.langto,
      input: data.raw,
      apiKey: data.secret,
      onUpdate(text) {
        data.result = text;
        refresh();
      },
    });
    refresh();
  },
};
