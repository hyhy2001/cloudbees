/**
 * User-related DTOs.
 * Mirrors legacy/cb/dtos/user.py
 */

import { str, arr } from "./base.js";

/** Shape returned by `/me/api/json` and `/user/<id>/api/json`. */
export interface UserDTO {
  id: string;
  fullName: string;
  description: string;
  url: string;
}

/** A CloudBees role/team with its member usernames. */
export interface TeamDTO {
  name: string;
  description: string;
  members: string[];
}

/** Maps a raw user API entry to UserDTO. Note `absoluteUrl` → `url`. */
export function userFromDict(data: Record<string, unknown>): UserDTO {
  return {
    id: str(data["id"]),
    fullName: str(data["fullName"]),
    description: str(data["description"]),
    url: str(data["absoluteUrl"]),
  };
}

/** Maps a raw team API entry to TeamDTO; `members` defaults to an empty array. */
export function teamFromDict(data: Record<string, unknown>): TeamDTO {
  return {
    name: str(data["name"]),
    description: str(data["description"]),
    members: arr<string>(data["members"], []),
  };
}
