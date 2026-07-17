import {
  getLastTranslateTask,
  TranslateTask,
  TranslateTaskRunner,
} from "../../utils/task";
import { TranslateService } from "./base";
import { PaperContextTranslation } from "./paperContext";

const registered: readonly TranslateService[] = Object.freeze([
  PaperContextTranslation,
]);

export class TranslationServices {
  public getServiceById(id: string): TranslateService | undefined {
    return registered.find((service) => service.id === id);
  }

  public getAllServices(): TranslateService[] {
    return [...registered];
  }

  public getAllServicesWithType(type: string): TranslateService[] {
    return registered.filter((service) => service.type === type);
  }

  public getServiceNameByID(id: string): string {
    return this.getServiceById(id)?.name || "Paper Context Translation";
  }

  public getAllServiceNames(): string[] {
    return registered.map((service) => this.getServiceNameByID(service.id));
  }

  public getAllServiceNamesWithType(type: string): string[] {
    return this.getAllServicesWithType(type).map((service) =>
      this.getServiceNameByID(service.id),
    );
  }

  public getUnconfiguredServiceIds(): Set<string> {
    return new Set();
  }

  public async runTranslationTask(
    task?: TranslateTask,
    options: {
      noCheckZoteroItemLanguage?: boolean;
      noDisplay?: boolean;
      noCache?: boolean;
    } = {},
  ): Promise<boolean> {
    task = task || getLastTranslateTask();
    if (!task?.raw.trim()) return false;
    if (task.type !== "text") {
      task.result = `Unsupported translation task type: ${task.type}`;
      task.status = "fail";
      return false;
    }
    task.result = "";
    task.status = "processing";
    if (!options.noDisplay) addon.api.getTemporaryRefreshHandler()();

    if (!options.noCache) {
      const cached = addon.data.translate.queue.findLast(
        (candidate) =>
          candidate !== task &&
          candidate.status === "success" &&
          candidate.raw === task!.raw &&
          candidate.itemId === task!.itemId &&
          candidate.langfrom === task!.langfrom &&
          candidate.langto === task!.langto,
      );
      if (cached) {
        task.result = cached.result;
        task.status = "success";
        if (!options.noDisplay) addon.api.getTemporaryRefreshHandler()();
        return true;
      }
    }

    const service = this.getServiceById(task.service);
    if (!service) {
      task.result = `Translation service is not implemented: ${task.service}`;
      task.status = "fail";
      return false;
    }
    await new TranslateTaskRunner(service.translate).run(task);
    if (!options.noDisplay) addon.api.getTemporaryRefreshHandler()();
    return (task.status as TranslateTask["status"]) === "success";
  }
}

export const services = new TranslationServices();
