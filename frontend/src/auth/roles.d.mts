export type NormalizedUserRole = "user" | "admin" | "super_admin";
export function normalizeUserRole(role?: unknown): NormalizedUserRole;
export function normalizeAuthUser<T extends object>(user: T): T & { role: NormalizedUserRole };
export function normalizeAuthUser(user: null | undefined): null;
export function isAdminRole(role?: unknown): boolean;
