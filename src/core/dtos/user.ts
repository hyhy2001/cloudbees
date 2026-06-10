/**
 * User-related DTOs.
 * Mirrors legacy/cb/dtos/user.py
 */

import { str, arr } from "./base.js";

export interface UserDTO {
  id: string;
  fullName: string;
  description: string;
  url: string;
}

export interface TeamDTO {
  name: string;
  description: string;
  members: string[];
}

export function userFromDict(data: Record<string, unknown>): UserDTO {
  return {
    id: str(data["id"]),
    fullName: str(data["fullName"]),
    description: str(data["description"]),
    url: str(data["absoluteUrl"]),
  };
}

export function teamFromDict(data: Record<string, unknown>): TeamDTO {
  return {
    name: str(data["name"]),
    description: str(data["description"]),
    members: arr<string>(data["members"], []),
  };
}
