import { TranslateTaskProcessor } from "../../utils/task";

export interface TranslateService {
  /**
   * The unique service ID.
   *
   * Use lowercase letters + hyphens only.
   */
  id: string;

  /**
   * The display name of the service.
   *
   * @default getString(`service-${id}`)
   */
  name?: string;

  /**
   * The type of translation service.
   *
   */
  type: "word" | "sentence";

  /**
   * Documentation or help page URL.
   *
   * If provided, a "Help" button will appear in the settings dialog.
   */
  helpUrl?: string;

  /**
   * Main translation function.
   *
   * - Must set `data.result` before returning.
   * - Should throw an error if the request fails.
   */
  translate: TranslateTaskProcessor;

  /**
   * Set this to true if the service requires external configuration (e.g. Pull Docker images or install softwares).
   *
   * - The services will be grouped as `Require Config`📍.
   * - The label📍will be automatically added to the service name in `addon/locale/${lang}/addon.ftl`.
   * - Omit if no external configuration is required.
   */
  requireExternalConfig?: boolean;
}
