export const ADMIN_ROLES = new Set(["admin", "super_admin"]);

/** @param {...string} roles */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role || "user")) {
    res.status(403).json({ error: "Access denied." });
    return;
  }
  next();
};

export const requireAdmin = requireRole("admin", "super_admin");
export const requireSuperAdmin = requireRole("super_admin");
export const isAccountActive = (user) => Boolean(user) && (user.status || "active") === "active";

/** @param {{role?: string}|null|undefined} actor @param {{role?: string}|null|undefined} target */
export const canManageUser = (actor, target) => {
  if (!ADMIN_ROLES.has(actor?.role)) return false;
  if (target?.role === "super_admin" && actor.role !== "super_admin") return false;
  return true;
};

/**
 * @param {{role?: string}|null|undefined} actor
 * @param {{role?: string}|null|undefined} target
 * @param {string} nextRole
 */
export const canChangeUserRole = (actor, target, nextRole) =>
  actor?.role === "super_admin" &&
  target?.role !== "super_admin" &&
  ["user", "admin"].includes(nextRole);
