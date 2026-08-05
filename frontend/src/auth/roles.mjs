const ADMIN_ROLE_ALIASES = new Set(["super_admin", "super-admin", "superadmin"]);

export const normalizeUserRole = (role) => {
  const value = String(role || "user").trim().toLowerCase();
  if (ADMIN_ROLE_ALIASES.has(value)) return "super_admin";
  if (value === "admin") return "admin";
  return "user";
};

export const normalizeAuthUser = (user) => user && typeof user === "object"
  ? { ...user, role: normalizeUserRole(user.role) }
  : null;

export const isAdminRole = (role) => ["admin", "super_admin"].includes(normalizeUserRole(role));
