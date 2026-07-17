import api from "./api";
import hooks from "./hooks";
import { TranslateTask } from "./utils/task";
import { services, TranslationServices } from "./modules/services";
import { createZToolkit } from "./utils/ztoolkit";
import { config } from "../package.json";

class Addon {
  public data: {
    config: typeof config;
    alive: boolean;
    // Env type, see build.js
    env: "development" | "production";
    ztoolkit: ZToolkit;
    locale: {
      current?: any;
    };
    prefs: {
      window: Window | null;
    };
    popup: {
      currentPopup: HTMLDivElement | null;
    };
    translate: {
      selectedText: string;
      queue: TranslateTask[];
      maximumQueueLength: number;
      services: TranslationServices;
      cachedSourceLanguage: Record<number, string>;
      refreshTick: string;
    };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: typeof api;

  constructor() {
    this.data = {
      config,
      alive: true,
      env: __env__,
      ztoolkit: createZToolkit(),
      locale: {},
      prefs: { window: null },
      popup: { currentPopup: null },
      translate: {
        selectedText: "",
        queue: [],
        maximumQueueLength: 100,
        services,
        cachedSourceLanguage: {},
        refreshTick: "",
      },
    };
    this.hooks = hooks;
    this.api = api;
  }
}

export default Addon;
