/**
 * Controller plugin — local DTOs not already in core/dtos.
 * Ports legacy/cb/services/controller_service.py CapabilityInfo dataclass.
 */

export interface CapabilityInfo {
  name: string;
  url: string;
  typeLabel: string;
  online: boolean;
  canCreateJob: boolean;
  canCreateNode: boolean;
  canCreateCred: boolean;
  description: string;
}
