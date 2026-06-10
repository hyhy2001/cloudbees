/**
 * Controller DTO.
 * Mirrors legacy/cb/dtos/controller.py
 */

import { str, bool } from "./base.js";

export interface ControllerDTO {
  name: string;
  url: string;
  description: string;
  className: string;
  online: boolean;
}

export function controllerFromDict(data: Record<string, unknown>): ControllerDTO {
  return {
    name: str(data["name"]),
    url: str(data["url"]),
    description: str(data["description"]),
    className: str(data["_class"]),
    online: !bool(data["offline"], false),
  };
}
